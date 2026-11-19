import { getServerTime, isCalibrated } from '@/lib/clockSync'
import { PLAYER_PLAY_DEDUP_MS } from '@/lib/constants'
import { storage } from '@/lib/storage'
import { useSocketContext } from '@/providers/SocketProvider'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import type { ScheduledPlayState, Track } from '@music-together/shared'
import { EVENTS } from '@music-together/shared'
import { useCallback, useEffect, useRef } from 'react'
import {
  detectTrackDesync,
  estimateRoomPosition,
  isLoadStalled,
  isPlaybackStartStalled,
  mayRetry,
  LOCAL_PAUSED_STUCK_MS,
  RECONCILE_DEBOUNCE_MS,
  RECONCILE_INTERVAL_MS,
} from '@/lib/playbackReconcile'
import { useHowl } from './useHowl'
import { useLyric } from './useLyric'
import { useMediaSession } from './useMediaSession'
import { usePlayerSync } from './usePlayerSync'

/**
 * Composing hook: useHowl + useLyric + usePlayerSync.
 * Provides unified playback controls.
 *
 * Architecture: **Scheduled Execution**.
 * All player actions (play, pause, seek, resume) are emitted to the server
 * which broadcasts a `ScheduledPlayState` to ALL clients (including the
 * initiator). Clients then execute the action at the scheduled server-time
 * so that every device acts in unison.
 */
export function usePlayer() {
  const { socket } = useSocketContext()
  const loadingRef = useRef<{ trackId: string; ts: number; serverTimestamp: number } | null>(null)
  // Set by recovery effect to signal onPlayerPlay that this track was already
  // loaded by reconnect recovery — the subsequent PLAYER_PLAY from
  // syncPlaybackToSocket should be skipped to avoid a double-load.
  const recoveredTrackIdRef = useRef<string | null>(null)

  const next = useCallback(() => socket.emit(EVENTS.PLAYER_NEXT), [socket])

  // Auto-next on song end: only the current conductor (hostId) emits PLAYER_NEXT.
  // The conductor is auto-elected by the server (owner > admin > member).
  // Other clients silently wait to prevent duplicate PLAYER_NEXT events.
  const autoNext = useCallback(() => {
    const { room } = useRoomStore.getState()
    const myId = storage.getUserId()
    if (room?.hostId === myId) {
      socket.emit(EVENTS.PLAYER_NEXT)
    }
  }, [socket])

  const { howlRef, soundIdRef, loadTrack, loadStateRef } = useHowl(autoNext)
  const { fetchLyric } = useLyric()

  // -------------------------------------------------------------------------
  // 播放对账（playback reconciliation）
  //
  // 弱网下本地播放器可能与房间状态永久脱钩，而此前没有任何兜底：
  //   1. 漏收 PLAYER_PLAY → 本地还停在上一首；
  //   2. 媒体请求挂起（既无 onload 也无 onloaderror）→ 播放器永远起不来；
  //   3. 该播却没播（元素停住/被系统暂停）→ 点播放键只是对死元素调用 play()。
  // 看门狗按固定间隔检查上述三种状态，必要时按服务端权威状态重载，并带退避重试。
  // -------------------------------------------------------------------------
  const reconcileRef = useRef({
    mismatchSince: null as number | null,
    pausedSince: null as number | null,
    attempt: 0,
    lastAttemptAt: 0,
    lastSyncRequestAt: 0,
  })

  /** 向服务端要一次权威状态（同步响应会带回当前曲目 + 位置），用于漏收事件后的自愈 */
  const requestAuthoritativeSync = useCallback(() => {
    const st = reconcileRef.current
    const now = Date.now()
    if (now - st.lastSyncRequestAt < RECONCILE_INTERVAL_MS) return
    st.lastSyncRequestAt = now
    socket.emit(EVENTS.PLAYER_SYNC_REQUEST)
  }, [socket])

  /** 按房间状态（权威曲目 + 估算位置）重载本地播放器 */
  const loadFromRoomState = useCallback(
    (override?: { track?: Track; position?: number; shouldPlay?: boolean }) => {
      const { room } = useRoomStore.getState()
      if (!room) return
      const track = override?.track ?? room.currentTrack
      if (!track?.streamUrl) return

      const shouldPlay = override?.shouldPlay ?? room.playState.isPlaying
      const position = override?.position ?? estimateRoomPosition(room.playState, getServerTime(), track.duration)
      console.warn('[reconcile] reloading room track', track.title, 'at', position.toFixed(1), 'playing=', shouldPlay)
      // 标记为已恢复：紧随其后的 PLAYER_PLAY 不再重复加载
      recoveredTrackIdRef.current = track.id
      loadTrack(track, position, shouldPlay)
      fetchLyric(track)
    },
    [fetchLyric, loadTrack],
  )

  /** 同步响应带回的权威曲目/状态与本地不一致时，以服务端为准重载 */
  const handleSyncTrack = useCallback(
    (data: { track: Track; currentTime: number; isPlaying: boolean; serverTimestamp: number }) => {
      useRoomStore.getState().updateRoom({
        currentTrack: data.track,
        playState: {
          isPlaying: data.isPlaying,
          currentTime: data.currentTime,
          serverTimestamp: data.serverTimestamp,
        },
      })
      loadFromRoomState({
        track: data.track,
        position: Math.max(0, data.currentTime),
        shouldPlay: data.isPlaying,
      })
    },
    [loadFromRoomState],
  )

  // Connect sync (handles SEEK, PAUSE, RESUME + conductor reporting)
  usePlayerSync(howlRef, soundIdRef, loadTrack, { onSyncTrack: handleSyncTrack })

  // -----------------------------------------------------------------------
  // 对账看门狗：把本地播放器从"卡死"状态里拉回来（只在前台运行）。
  // -----------------------------------------------------------------------
  useEffect(() => {
    const attemptReload = () => {
      const st = reconcileRef.current
      const now = Date.now()
      if (!mayRetry(st.lastAttemptAt, st.attempt, now)) return
      st.attempt += 1
      st.lastAttemptAt = now
      // 先要一次权威状态（顺带修复 store 里可能也已过期的曲目），再按当前状态重载
      requestAuthoritativeSync()
      loadFromRoomState()
    }

    const tick = () => {
      if (document.visibilityState === 'hidden') return
      const { room } = useRoomStore.getState()
      const player = usePlayerStore.getState()
      const st = reconcileRef.current
      const now = Date.now()

      // 不在房间 / 房间没有当前曲目：交给 roomStore 的恢复逻辑，重置判定窗口
      if (!room?.currentTrack) {
        st.mismatchSince = null
        st.pausedSince = null
        return
      }

      const desync = detectTrackDesync({
        roomTrackId: room.currentTrack.id,
        playerTrackId: player.currentTrack?.id ?? null,
        hasHowl: Boolean(howlRef.current),
      })

      if (desync) {
        st.pausedSince = null
        if (st.mismatchSince === null) st.mismatchSince = now
        if (now - st.mismatchSince >= RECONCILE_DEBOUNCE_MS) attemptReload()
        return
      }
      st.mismatchSince = null

      // 同一曲目，但加载始终没完成（媒体请求挂起：onload 与 onloaderror 都不会来）
      const load = loadStateRef.current
      if (isLoadStalled(load, now) || isPlaybackStartStalled(load, now)) {
        st.pausedSince = null
        attemptReload()
        return
      }

      // 已加载过，但房间在播、本地却停着（元素停住 / 被系统暂停）
      if (room.playState.isPlaying && load?.playedOnce && !player.isPlaying) {
        if (st.pausedSince === null) st.pausedSince = now
        if (now - st.pausedSince >= LOCAL_PAUSED_STUCK_MS) {
          st.pausedSince = null
          attemptReload()
        }
        return
      }
      st.pausedSince = null

      // 恢复正常：重置退避，下次卡顿时可以立刻重试
      if (player.isPlaying) {
        st.attempt = 0
        st.lastAttemptAt = 0
      }
    }

    const interval = setInterval(tick, RECONCILE_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    // 启动时先跑一次（覆盖刷新后立即处于卡死状态的场景）
    tick()

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [howlRef, loadStateRef, requestAuthoritativeSync, loadFromRoomState])

  // Reset dedup ref on disconnect so reconnect PLAYER_PLAY is never blocked
  useEffect(() => {
    const onDisconnect = () => {
      loadingRef.current = null
      recoveredTrackIdRef.current = null
    }
    socket.on('disconnect', onDisconnect)
    return () => {
      socket.off('disconnect', onDisconnect)
    }
  }, [socket])

  // Listen for PLAYER_PLAY events (new track load)
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onPlayerPlay = (data: { track: Track; playState: ScheduledPlayState }) => {
      // Deduplicate: ignore if the same track with the same serverTimestamp
      // was requested within the dedup window.  Comparing serverTimestamp
      // ensures that a legitimate replay of the same track (e.g. loop mode)
      // with a different serverTimestamp is not discarded.
      const now = Date.now()
      if (
        loadingRef.current?.trackId === data.track.id &&
        loadingRef.current.serverTimestamp === data.playState.serverTimestamp &&
        now - loadingRef.current.ts < PLAYER_PLAY_DEDUP_MS
      ) {
        return
      }
      // Recovery already loaded this track (reconnect: ROOM_STATE → recovery
      // loadTrack → PLAYER_PLAY from syncPlaybackToSocket).  The serverTimestamp
      // differs (syncPlaybackToSocket computes a new scheduleTime) so the normal
      // dedup above doesn't catch it.  Skip the redundant load but update
      // roomStore with the authoritative scheduled playState.
      if (recoveredTrackIdRef.current === data.track.id) {
        recoveredTrackIdRef.current = null
        loadingRef.current = { trackId: data.track.id, ts: now, serverTimestamp: data.playState.serverTimestamp }
        useRoomStore.getState().updateRoom({
          currentTrack: data.track,
          playState: {
            isPlaying: data.playState.isPlaying,
            currentTime: data.playState.currentTime,
            serverTimestamp: data.playState.serverTimestamp,
          },
        })
        return
      }
      loadingRef.current = { trackId: data.track.id, ts: now, serverTimestamp: data.playState.serverTimestamp }

      // Keep roomStore in sync so recovery effect sees the correct currentTrack
      useRoomStore.getState().updateRoom({
        currentTrack: data.track,
        playState: {
          isPlaying: data.playState.isPlaying,
          currentTime: data.playState.currentTime,
          serverTimestamp: data.playState.serverTimestamp,
        },
      })

      const ct = data.playState.currentTime
      const executeDelay = Math.max(
        0,
        data.playState.serverTimeToExecute - (isCalibrated() ? getServerTime() : Date.now()),
      )

      if (ct > 0 && data.playState.isPlaying && executeDelay > 0) {
        if (playTimerRef.current) clearTimeout(playTimerRef.current)
        playTimerRef.current = setTimeout(() => {
          playTimerRef.current = null
          loadTrack(data.track, ct, data.playState.isPlaying)
          fetchLyric(data.track)
        }, executeDelay)
        return
      }

      if (ct === 0 && data.playState.serverTimeToExecute) {
        // New track from position 0: schedule load so playback begins at
        // the coordinated server-time.  We load with autoPlay=true and let
        // the scheduling delay account for buffering.
        // When NTP is not yet calibrated, execute immediately (delay=0) to
        // avoid wildly inaccurate scheduling from uncorrected local clocks.
        const delay = isCalibrated() ? Math.max(0, data.playState.serverTimeToExecute - getServerTime()) : 0
        if (playTimerRef.current) clearTimeout(playTimerRef.current)
        playTimerRef.current = setTimeout(() => {
          playTimerRef.current = null
          loadTrack(data.track, 0, data.playState.isPlaying)
          fetchLyric(data.track)
        }, delay)
      } else {
        // Mid-song join or currentTime > 0: load immediately and seek to
        // the expected position at the scheduled execution time.
        const elapsed = data.playState.isPlaying
          ? Math.max(0, (getServerTime() - data.playState.serverTimestamp) / 1000)
          : 0
        const adjustedTime = ct + elapsed

        loadTrack(data.track, adjustedTime, data.playState.isPlaying)
        fetchLyric(data.track)
      }
    }

    socket.on(EVENTS.PLAYER_PLAY, onPlayerPlay)

    return () => {
      socket.off(EVENTS.PLAYER_PLAY, onPlayerPlay)
      if (playTimerRef.current) {
        clearTimeout(playTimerRef.current)
        playTimerRef.current = null
      }
    }
  }, [socket, loadTrack, fetchLyric])

  // Recovery: auto-sync player state from room state when desync is detected
  // (e.g. after HMR resets stores, or reconnection where PLAYER_PLAY was missed)
  useEffect(() => {
    let hasRecovered = false

    const recover = () => {
      const { room } = useRoomStore.getState()

      // When room becomes null (disconnect), reset flag so next reconnect can recover
      if (!room) {
        hasRecovered = false
        return
      }

      if (hasRecovered) return
      const playerTrack = usePlayerStore.getState().currentTrack
      const roomTrack = room.currentTrack

      // Server has cleared the track (queue empty / cleared) — reset client
      if (!roomTrack && playerTrack) {
        hasRecovered = true
        if (howlRef.current) {
          try {
            howlRef.current.unload()
          } catch {
            /* ignore */
          }
          howlRef.current = null
        }
        soundIdRef.current = undefined
        usePlayerStore.getState().reset()
        return
      }

      // Server has track but client doesn't (HMR reset / missed PLAYER_PLAY)
      if (roomTrack?.streamUrl && (!playerTrack || !howlRef.current)) {
        // Skip if onPlayerPlay is already handling this track — its updateRoom()
        // call triggers this subscription synchronously before loadTrack runs,
        // so playerTrack/howlRef are still stale. Checking loadingRef avoids
        // a redundant double-load.
        // However, if howlRef is null despite loadingRef pointing to this track,
        // the previous loadTrack failed (e.g. !streamUrl) and we should retry.
        if (loadingRef.current?.trackId === roomTrack.id && howlRef.current) return

        hasRecovered = true
        // Cancel any pending scheduled load from onPlayerPlay to prevent
        // a second loadTrack call when the timer fires after recovery.
        if (playTimerRef.current) {
          clearTimeout(playTimerRef.current)
          playTimerRef.current = null
        }
        const ps = room.playState
        const elapsed = ps.isPlaying ? (getServerTime() - ps.serverTimestamp) / 1000 : 0
        recoveredTrackIdRef.current = roomTrack.id
        loadTrack(roomTrack, ps.currentTime + Math.max(0, elapsed), ps.isPlaying)
        fetchLyric(roomTrack)
      }
    }

    // Check immediately (covers HMR where roomStore already has data)
    recover()

    // Subscribe for future changes (covers reconnect where ROOM_STATE arrives later)
    const unsubscribe = useRoomStore.subscribe(recover)
    return unsubscribe
    // `socket` intentionally excluded — effect subscribes to roomStore, not socket directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTrack, fetchLyric])

  // -----------------------------------------------------------------------
  // Controls — emit to server only.  Server broadcasts ScheduledPlayState
  // to ALL clients (including us) via scheduled execution.
  // -----------------------------------------------------------------------
  const play = useCallback(() => {
    socket.emit(EVENTS.PLAYER_PLAY)
  }, [socket])

  const pause = useCallback(() => {
    socket.emit(EVENTS.PLAYER_PAUSE)
  }, [socket])

  const seek = useCallback(
    (time: number) => {
      // Optimistic local update for the progress bar UI
      usePlayerStore.getState().setCurrentTime(time)
      socket.emit(EVENTS.PLAYER_SEEK, { currentTime: time })
    },
    [socket],
  )

  const prev = useCallback(() => socket.emit(EVENTS.PLAYER_PREV), [socket])

  // MediaSession: hardware media keys + OS media notification bar.
  // Permission-aware: mirrors PlayerControls fallback-to-vote behaviour.
  useMediaSession({ play, pause, next, prev, seek })

  return { play, pause, seek, next, prev }
}
