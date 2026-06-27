import { getServerTime, isCalibrated } from '@/lib/clockSync'
import {
  CONDUCTOR_REPORT_INTERVAL_MS,
  CONDUCTOR_REPORT_FAST_INTERVAL_MS,
  CONDUCTOR_REPORT_FAST_DURATION_MS,
  MAX_NETWORK_DELAY_S,
  SYNC_REQUEST_INTERVAL_MS,
  SYNC_HARD_SEEK_THRESHOLD_S,
  SYNC_INITIAL_WINDOW_MS,
} from '@/lib/constants'
import { storage } from '@/lib/storage'
import { useSocketContext } from '@/providers/SocketProvider'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import type { ScheduledPlayState } from '@music-together/shared'
import { EVENTS } from '@music-together/shared'
import type { Howl } from 'howler'
import { useEffect, useRef, type RefObject } from 'react'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the delay (ms) until `serverTimeToExecute`, using our
 * NTP-calibrated clock.  Returns 0 if the time has already passed.
 * Falls back to 0 (immediate execution) when NTP is not yet calibrated
 * to avoid wildly inaccurate scheduling from uncorrected local clocks.
 */
function scheduleDelay(serverTimeToExecute: number): number {
  if (!isCalibrated()) return 0
  return Math.max(0, serverTimeToExecute - getServerTime())
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages playback sync via **event-driven Scheduled Execution**
 * with **lazy drift correction**:
 *
 *   |drift| < 5s  → no correction (smooth playback priority)
 *   |drift| ≥ 5s  → hard seek to expected position (after 2 confirmations)
 *
 * The high threshold (5s) is deliberate — in a casual-listening scenario,
 * a few seconds of drift is far less disruptive than seek-induced
 * rebuffering.  Tighter synchronisation is provided by the initial
 * PLAYER_PLAY/SEEK events which carry a serverTimeToExecute for
 * coordinated execution.
 *
 * New tracks also get an initial no-sync window (SYNC_INITIAL_WINDOW_MS)
 * during which all SYNC_RESPONSE messages are ignored, giving the audio
 * buffer time to stabilise.
 */
export function usePlayerSync(howlRef: RefObject<Howl | null>, soundIdRef: RefObject<number | undefined>) {
  const { socket } = useSocketContext()
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime)

  // Pending scheduled action timers (so we can cancel on unmount / new action)
  const scheduledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic action ID — guards against stale setTimeout(fn, 0) callbacks
  // when rapid events arrive in the same event loop tick.
  const actionIdRef = useRef(0)
  // Timestamp when the current track started playing (for adaptive conductor reporting)
  const trackStartTimeRef = useRef(0)
  // No-sync window end timestamp (ms) — SYNC_RESPONSE is ignored before this
  const noSyncUntilRef = useRef(0)
  // Consecutive large-drift triggers — require 2 before actually seeking
  const largeDriftCountRef = useRef(0)

  const clearScheduled = () => {
    if (scheduledTimerRef.current) {
      clearTimeout(scheduledTimerRef.current)
      scheduledTimerRef.current = null
    }
  }

  // -----------------------------------------------------------------------
  // Scheduled action handlers
  // -----------------------------------------------------------------------
  useEffect(() => {
    // -- SEEK ---------------------------------------------------------------
    const onSeek = (data: { playState: ScheduledPlayState }) => {
      clearScheduled()
      const id = ++actionIdRef.current
      const delay = scheduleDelay(data.playState.serverTimeToExecute)

      scheduledTimerRef.current = setTimeout(() => {
        if (actionIdRef.current !== id) return // stale callback
        if (howlRef.current) {
          howlRef.current.seek(data.playState.currentTime)
          if (howlRef.current.rate() !== 1) howlRef.current.rate(1)
        }
        setCurrentTime(data.playState.currentTime)
        // Keep roomStore.playState in sync for recovery effect
        useRoomStore.getState().updateRoom({
          playState: {
            isPlaying: data.playState.isPlaying,
            currentTime: data.playState.currentTime,
            serverTimestamp: data.playState.serverTimestamp,
          },
        })
      }, delay)
    }

    // -- PAUSE --------------------------------------------------------------
    const onPause = (data: { playState: ScheduledPlayState }) => {
      clearScheduled()
      const id = ++actionIdRef.current
      const delay = scheduleDelay(data.playState.serverTimeToExecute)

      scheduledTimerRef.current = setTimeout(() => {
        if (actionIdRef.current !== id) return // stale callback
        if (howlRef.current && soundIdRef.current !== undefined) {
          howlRef.current.pause(soundIdRef.current)
          // Sync to the server's authoritative time snapshot
          howlRef.current.seek(data.playState.currentTime)
          if (howlRef.current.rate() !== 1) howlRef.current.rate(1)
          setCurrentTime(data.playState.currentTime)
        }
        usePlayerStore.getState().setSyncDrift(0)
        // Keep roomStore.playState in sync for recovery effect
        useRoomStore.getState().updateRoom({
          playState: {
            isPlaying: data.playState.isPlaying,
            currentTime: data.playState.currentTime,
            serverTimestamp: data.playState.serverTimestamp,
          },
        })
      }, delay)
    }

    // -- RESUME -------------------------------------------------------------
    const onResume = (data: { playState: ScheduledPlayState }) => {
      clearScheduled()
      const id = ++actionIdRef.current
      const delay = scheduleDelay(data.playState.serverTimeToExecute)

      scheduledTimerRef.current = setTimeout(() => {
        if (actionIdRef.current !== id) return // stale callback
        if (!howlRef.current) {
          // No Howl instance — the track likely has no streamUrl or loadTrack
          // was never called.  Ask the server to re-resolve the stream URL
          // rather than silently doing nothing.
          console.warn('onResume: no Howl instance, requesting server re-play')
          socket.emit(EVENTS.PLAYER_PLAY)
          return
        }
        // Seek to the expected position at this moment
        if (data.playState.currentTime > 0) {
          howlRef.current.seek(data.playState.currentTime)
          setCurrentTime(data.playState.currentTime)
        }
        if (howlRef.current.rate() !== 1) howlRef.current.rate(1)
        if (soundIdRef.current !== undefined) {
          howlRef.current.play(soundIdRef.current)
        } else {
          soundIdRef.current = howlRef.current.play()
        }
        // Keep roomStore.playState in sync for recovery effect
        useRoomStore.getState().updateRoom({
          playState: {
            isPlaying: data.playState.isPlaying,
            currentTime: data.playState.currentTime,
            serverTimestamp: data.playState.serverTimestamp,
          },
        })
      }, delay)
    }

    // -- NEW TRACK (PLAYER_PLAY) ---------------------------------------------
    // When a new track loads, cancel any pending action from the previous track
    // so it doesn't accidentally seek/pause/resume the new Howl instance.
    // Also set a no-sync window to let the audio buffer stabilise.
    const onPlay = () => {
      clearScheduled()
      ++actionIdRef.current // invalidate any pending stale callbacks
      largeDriftCountRef.current = 0
      trackStartTimeRef.current = Date.now()
      noSyncUntilRef.current = Date.now() + SYNC_INITIAL_WINDOW_MS
    }

    // -- SYNC RESPONSE (lazy drift correction) ------------------------------
    // Only correct when drift exceeds a generous 5s threshold, and only
    // after 2 consecutive confirmations.  The initial no-sync window
    // suppresses all corrections on a new track.
    const onSyncResponse = (data: { currentTime: number; isPlaying: boolean; serverTimestamp: number }) => {
      // No-sync window: let the audio buffer stabilise first
      if (Date.now() < noSyncUntilRef.current) return

      if (!howlRef.current) return
      if (!howlRef.current.playing()) return

      // Conductor (hostId) is the authoritative playback source — skip
      // drift correction to avoid a feedback loop.
      const { room: syncRoom } = useRoomStore.getState()
      const myId = storage.getUserId()
      if (syncRoom?.hostId === myId) return

      // Estimate the expected position at this moment
      const networkDelaySec = Math.max(
        0,
        Math.min(MAX_NETWORK_DELAY_S, (getServerTime() - data.serverTimestamp) / 1000),
      )
      const expectedTime = data.currentTime + (data.isPlaying ? networkDelaySec : 0)

      const currentSeek = howlRef.current.seek() as number
      const drift = currentSeek - expectedTime

      usePlayerStore.getState().setSyncDrift(0)

      if (Math.abs(drift) >= SYNC_HARD_SEEK_THRESHOLD_S) {
        largeDriftCountRef.current++
        if (largeDriftCountRef.current >= 2) {
          // Confirmed: large sustained drift — hard seek
          largeDriftCountRef.current = 0
          howlRef.current.seek(expectedTime)
          if (howlRef.current.rate() !== 1) howlRef.current.rate(1)
        }
      } else {
        // Within acceptable range — reset counter and ensure normal rate
        largeDriftCountRef.current = 0
        if (howlRef.current.rate() !== 1) howlRef.current.rate(1)
      }
    }

    socket.on(EVENTS.PLAYER_SEEK, onSeek)
    socket.on(EVENTS.PLAYER_PAUSE, onPause)
    socket.on(EVENTS.PLAYER_RESUME, onResume)
    socket.on(EVENTS.PLAYER_PLAY, onPlay)
    socket.on(EVENTS.PLAYER_SYNC_RESPONSE, onSyncResponse)

    return () => {
      clearScheduled()
      socket.off(EVENTS.PLAYER_SEEK, onSeek)
      socket.off(EVENTS.PLAYER_PAUSE, onPause)
      socket.off(EVENTS.PLAYER_RESUME, onResume)
      socket.off(EVENTS.PLAYER_PLAY, onPlay)
      socket.off(EVENTS.PLAYER_SYNC_RESPONSE, onSyncResponse)
    }
  }, [socket, howlRef, soundIdRef, setCurrentTime])

  // -----------------------------------------------------------------------
  // Periodic sync request (client-initiated drift correction).
  // Host skips: it is the authoritative source and reports its own position.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const interval = setInterval(() => {
      const { room: r2 } = useRoomStore.getState()
      const myId = storage.getUserId()
      if (r2?.hostId !== myId) {
        socket.emit(EVENTS.PLAYER_SYNC_REQUEST)
      }
    }, SYNC_REQUEST_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [socket])

  // -----------------------------------------------------------------------
  // Conductor progress reporting (keeps server-side playState accurate for
  // mid-song joiners and reconnection recovery).
  // Adaptive: fast interval (2s) for the first 10s of a new track,
  // then slows to the normal interval (5s) to reduce overhead.
  // -----------------------------------------------------------------------
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null

    const report = () => {
      const { room } = useRoomStore.getState()
      const myId = storage.getUserId()
      if (room?.hostId === myId && howlRef.current?.playing()) {
        socket.emit(EVENTS.PLAYER_SYNC, {
          currentTime: howlRef.current.seek() as number,
          hostServerTime: getServerTime(),
        })
      }
      // Schedule next report — fast if within the initial window, slow otherwise
      const elapsed = Date.now() - trackStartTimeRef.current
      const interval =
        elapsed < CONDUCTOR_REPORT_FAST_DURATION_MS ? CONDUCTOR_REPORT_FAST_INTERVAL_MS : CONDUCTOR_REPORT_INTERVAL_MS
      timerId = setTimeout(report, interval)
    }

    // When the tab returns from background, immediately send a conductor report
    // so the server's playState is refreshed after potential setTimeout throttling.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      const { room: r } = useRoomStore.getState()
      const myId = storage.getUserId()
      if (r?.hostId === myId && howlRef.current?.playing()) {
        socket.emit(EVENTS.PLAYER_SYNC, {
          currentTime: howlRef.current.seek() as number,
          hostServerTime: getServerTime(),
        })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    timerId = setTimeout(report, CONDUCTOR_REPORT_FAST_INTERVAL_MS)

    return () => {
      if (timerId) clearTimeout(timerId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [socket, howlRef])
}
