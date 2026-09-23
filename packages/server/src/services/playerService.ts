import type {
  AudioQuality,
  MusicSource,
  PlayMode,
  PlayState,
  PlayedTrack,
  ScheduledPlayState,
  Track,
} from '@music-together/shared'
import { EVENTS, ERROR_CODE, LIMITS, NTP } from '@music-together/shared'
import { roomRepo } from '../repositories/roomRepository.js'
import { nanoid } from 'nanoid'
import { musicProvider } from './musicProvider.js'
import * as queueService from './queueService.js'
import * as trackFallbackService from './trackFallbackService.js'
import * as authService from './authService.js'
import * as chatService from './chatService.js'
import { estimateCurrentTime } from './syncService.js'
import { broadcastRoomList } from './roomLifecycleService.js'
import { toPublicRoomState } from '../utils/roomUtils.js'
import { resolveDefaultQueueRef } from '../utils/defaultQueueRef.js'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import type { RoomData } from '../repositories/types.js'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

// ---------------------------------------------------------------------------
// Per-room mutex for playTrackInRoom (prevents concurrent execution)
// ---------------------------------------------------------------------------

const playMutexes = new Map<string, Promise<unknown>>()

// ---------------------------------------------------------------------------
// Auto fallback cooldown (prevents repeated attempts / ping-pong)
// ---------------------------------------------------------------------------

const autoFallbackCooldown = new Map<string, number>()

function canAutoFallback(roomId: string, trackId: string): boolean {
  const key = `${roomId}:${trackId}`
  const until = autoFallbackCooldown.get(key)
  if (!until) return true
  if (Date.now() >= until) {
    autoFallbackCooldown.delete(key)
    return true
  }
  return false
}

function markAutoFallback(roomId: string, trackId: string, ms: number): void {
  const key = `${roomId}:${trackId}`
  autoFallbackCooldown.set(key, Date.now() + ms)
}

function withPlayMutex<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const prev = playMutexes.get(roomId) ?? Promise.resolve()
  // The queued critical section inherits the previous section's promise, so the
  // budget must be created when THIS section actually starts running, not while
  // it is waiting for the lock (otherwise a 12s queue wait would consume the
  // whole budget before any upstream work begins).
  const run = async (): Promise<T> => {
    roomLockBudgets.set(roomId, createTimeoutBudget(ROOM_PLAY_LOCK_BUDGET_MS))
    try {
      return await fn()
    } finally {
      roomLockBudgets.delete(roomId)
    }
  }
  const next = prev.then(run, run)
  playMutexes.set(roomId, next)
  // Cleanup entry when chain settles to avoid unbounded growth
  const cleanup = () => {
    if (playMutexes.get(roomId) === next) playMutexes.delete(roomId)
  }
  // Do not ignore a Promise returned by finally(): when `next` rejects, that
  // derived Promise rejects too and becomes an unhandled rejection. Supplying
  // both handlers keeps cleanup rejection-neutral while callers still receive
  // the original `next` Promise below.
  void next.then(cleanup, cleanup)
  return next
}

// ---------------------------------------------------------------------------
// Scheduled execution helpers
// ---------------------------------------------------------------------------

/**
 * Compute the future server-time at which all clients should execute an
 * action, based on the P90 RTT in the room.
 */
function getScheduleTime(roomId: string): number {
  const maxRTT = roomRepo.getP90RTT(roomId)
  const delay = Math.min(Math.max(maxRTT * 1.5 + 100, NTP.MIN_SCHEDULE_DELAY_MS), NTP.MAX_SCHEDULE_DELAY_MS)
  return Date.now() + delay
}

/** Build a ScheduledPlayState from a plain PlayState.
 *  Accepts an optional pre-computed scheduleTime to keep room state and
 *  broadcast payload consistent (same timestamp for both). */
function scheduled(ps: PlayState, roomId: string, scheduleTime?: number): ScheduledPlayState {
  return { ...ps, serverTimeToExecute: scheduleTime ?? getScheduleTime(roomId) }
}

// ---------------------------------------------------------------------------
// Hard time budget for the in-lock stream-resolution path
// ---------------------------------------------------------------------------

/**
 * 房间播放锁内所有慢 I/O 共享的硬性总超时预算（毫秒）。
 *
 * 为什么需要它：`_playTrackInRoom` 全程持有按 roomId 串行的 play mutex，
 * 而解析上游可能极慢——生产容器实测网易云单曲解析 ≈46,500 ms。锁内慢 I/O 会把
 * 该房间的切歌 / 投票 / 接续播放全部排队，用户观感就是「房间卡死、只能换房间」。
 *
 * 为什么需要一个**跨调用共享**的预算（而不是给每次 `getStreamUrlResult` 各设一个
 * 超时）：一次播放尝试最多会串起 1 次主解析 + 3 次音质降级 + 1 次换源搜索 +
 * 1 次换源后解析，而 `_executePlayNext` / `playPrevTrackInRoom` 在一次锁内还会再
 * 重试 2~3 个候选曲目；`pickFromDefaultQueue` 另有最多 5 次条目补全。若每层各等
 * 一次，锁持有时长仍会叠乘到上百秒。因此这里按「锁临界区」发一个预算，临界区内
 * 所有等待都从同一个预算扣时间。
 *
 * 为什么是 12s：
 * - 它严格小于 musicProvider 单次上游请求上限 15s（API_TIMEOUT_MS），且小于投票
 *   窗口 30s（VOTE_TIMING.VOTE_TIMEOUT_MS），投票触发的切歌不会先在锁里耗光投票时效。
 * - 正常解析远低于该值（B 站失败实测 87ms、网易云命中缓存为毫秒级），不会误杀健康请求。
 * - 由此得到可直接断言的不变量：**房间播放锁的单次持有时长上界 ≈ 12s**，与上游有
 *   多慢无关（加固前实测 46.5s，理论上界 >100s）。
 */
export const ROOM_PLAY_LOCK_BUDGET_MS = 12_000

interface TimeoutBudget {
  /** 预算剩余毫秒数；0 表示已耗尽。 */
  remainingMs: () => number
}

/**
 * 一次锁临界区内允许的慢 I/O 总预算。
 * 由 `withPlayMutex` 在临界区开始时建立、结束时清理；临界区外的调用方按需临时创建。
 */
const roomLockBudgets = new Map<string, TimeoutBudget>()

/** 创建一个从当前时刻开始计时的共享预算。 */
function createTimeoutBudget(totalMs: number): TimeoutBudget {
  const deadline = Date.now() + totalMs
  return { remainingMs: () => Math.max(0, deadline - Date.now()) }
}

/** 取当前锁临界区的共享预算；临界区外调用（如直接 playFromDefaultQueue）退回临时预算。 */
function getLockBudget(roomId: string): TimeoutBudget {
  return roomLockBudgets.get(roomId) ?? createTimeoutBudget(ROOM_PLAY_LOCK_BUDGET_MS)
}

/**
 * 在共享预算内等待 `work`：预算耗尽即放弃等待。返回 `{ ok: false }` 表示超时，
 * 调用方**绝不能**把 `null` 当成超时——很多被包裹的调用（如默认列表条目补全）
 * 合法地会返回 `null`。
 *
 * 败下阵来的 promise 仍在后台运行（fetch 无法取消），但它的返回值永远不会被
 * 采纳——调用方只接受这里返回的结果，因此不会出现「超时之后慢响应又回来改写
 * 房间状态」的竞态。
 */
async function raceBudget<T>(budget: TimeoutBudget, work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const remaining = budget.remainingMs()
  if (remaining <= 0) return { ok: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), remaining)
  })
  try {
    return await Promise.race([work.then((value) => ({ ok: true, value }) as const), expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 预算耗尽时的统一失败结果：按 `timeout` 分类，走既有失败路径。 */
function timeoutStreamResult(): {
  url: null
  reason: import('./musicProvider.js').StreamUrlFailureReason
  detail: string
} {
  return { url: null, reason: 'timeout', detail: '播放链接解析超出房间超时预算' }
}

// ---------------------------------------------------------------------------
// Audio quality fallback
// ---------------------------------------------------------------------------

/** Ordered fallback bitrates for each quality tier */
const BITRATE_FALLBACKS: Record<AudioQuality, AudioQuality[]> = {
  999: [320, 192, 128],
  320: [192, 128],
  192: [128],
  128: [],
}

/**
 * Try to get a stream URL at the requested bitrate. If it fails, try each
 * lower tier in order until one succeeds or all options are exhausted.
 *
 * 每一级重试都从**同一个** `budget` 里扣时间：逐级重试共享总预算，而不是
 * 每级各等一次（否则最坏情况会叠乘成 N × 单次上限）。
 */
async function resolveStreamUrl(
  source: MusicSource,
  urlId: string,
  bitrate: AudioQuality,
  cookie: string | undefined,
  budget: TimeoutBudget,
): Promise<{
  url: string | null
  reason?: import('./musicProvider.js').StreamUrlFailureReason
  detail?: string
  backupUrl?: string
}> {
  const primaryOutcome = await raceBudget(budget, musicProvider.getStreamUrlResult(source, urlId, bitrate, cookie))
  if (!primaryOutcome.ok) {
    logger.warn(`Stream resolve budget exhausted before ${source}/${urlId} responded`, { urlId })
    return timeoutStreamResult()
  }
  const primary = primaryOutcome.value
  if (primary.url) return primary

  // 「需要登录 / VIP 版权受限」是比「超时」更可操作的结论；逐级重试超时不应该
  // 把它覆盖成 timeout，否则用户会收到误导性的提示。
  const definitiveVerdict = primary.reason === 'login_required' || primary.reason === 'vip_or_copyright'

  // Fallback to lower bitrates
  for (const fallback of BITRATE_FALLBACKS[bitrate]) {
    if (budget.remainingMs() <= 0) break
    const fallbackOutcome = await raceBudget(budget, musicProvider.getStreamUrlResult(source, urlId, fallback, cookie))
    if (!fallbackOutcome.ok) break
    const fallbackResult = fallbackOutcome.value
    if (fallbackResult.url) {
      logger.info(`Bitrate fallback: ${bitrate} -> ${fallback} for ${source}/${urlId}`)
      return fallbackResult
    }
    // Keep the most specific non-null reason from later attempts
    if (fallbackResult.reason) {
      primary.reason = fallbackResult.reason
      primary.detail = fallbackResult.detail
    }
  }

  if (!primary.url && budget.remainingMs() <= 0 && !definitiveVerdict) {
    return timeoutStreamResult()
  }
  return primary
}

function streamFailureHint(
  source: MusicSource,
  reason: import('./musicProvider.js').StreamUrlFailureReason | undefined,
  options: { isVip?: boolean; hasCookie?: boolean; detail?: string },
): { hint: string; reasonType: 'VIP_REQUIRED' | 'COPYRIGHT_RESTRICTED' | 'NO_RESOURCE' | 'TIMEOUT' | 'UNKNOWN' } {
  if (reason === 'timeout') {
    return { hint: '（获取播放链接超时）', reasonType: 'TIMEOUT' }
  }
  if (reason === 'login_required' || (options.isVip && !options.hasCookie)) {
    if (source === 'netease') {
      return { hint: '（需要有用户在房间设置中登录网易云）', reasonType: 'VIP_REQUIRED' }
    }
    if (source === 'kugou') {
      return { hint: '（酷狗播放链接获取失败，请尝试在房间设置中登录酷狗）', reasonType: 'VIP_REQUIRED' }
    }
    if (source === 'tencent') {
      return {
        hint: '（未登录 QQ 音乐；若服务器无法直连，可在设置中开启「QQ 音乐浏览器中继」）',
        reasonType: 'VIP_REQUIRED',
      }
    }
    return { hint: '（需要登录后播放）', reasonType: 'VIP_REQUIRED' }
  }
  if (reason === 'vip_or_copyright' || options.isVip) {
    if (source === 'tencent') {
      return {
        hint: '（可能是 QQ 音乐屏蔽了非大陆 IP，可尝试在设置中打开「QQ 音乐浏览器中继」功能）',
        reasonType: 'COPYRIGHT_RESTRICTED',
      }
    }
    return {
      hint: options.hasCookie
        ? '（版权或 VIP 限制，当前登录账号可能无权播放）'
        : '（VIP / 版权受限，需要有用户登录对应平台账号）',
      reasonType: 'COPYRIGHT_RESTRICTED',
    }
  }
  if (options.detail) {
    return { hint: `（${options.detail}）`, reasonType: 'NO_RESOURCE' }
  }
  return { hint: '', reasonType: 'UNKNOWN' }
}

/** Load the room-local registry lazily to avoid a module initialization cycle. */
async function refreshLocalTrack(roomId: string, track: Track, allowPendingCurrent = false): Promise<Track | null> {
  const { localAudioService } = await import('./localAudioService.js')
  return localAudioService.refreshTrack(roomId, track, allowPendingCurrent)
}

/**
 * Resolve stream URL / cover, set current track, and broadcast PLAYER_PLAY.
 * Returns true on success, false on failure.
 * Serialized per room via mutex to prevent concurrent state corruption.
 */
export function playTrackInRoom(io: TypedServer, roomId: string, track: Track): Promise<boolean> {
  return withPlayMutex(roomId, () => _playTrackInRoom(io, roomId, track))
}

/**
 * Auto-play when the queue was empty. Re-checks `room.currentTrack` inside
 * the mutex so that concurrent QUEUE_ADD handlers don't both trigger playback
 * (the second caller sees the track set by the first and bails out).
 */
export function autoPlayIfEmpty(io: TypedServer, roomId: string, track: Track): Promise<boolean> {
  return withPlayMutex(roomId, async () => {
    const room = roomRepo.get(roomId)
    if (!room || room.currentTrack) return false
    return _playTrackInRoom(io, roomId, track)
  })
}

async function _playTrackInRoom(io: TypedServer, roomId: string, track: Track): Promise<boolean> {
  const room = roomRepo.get(roomId)
  if (!room) return false

  // 整个「解析播放链接」阶段（含逐级音质重试、自动换源搜索、换源后的二次解析、
  // 封面补全）共享本锁临界区的同一个硬性预算：无论上游多慢，本函数在预算耗尽后
  // 必定返回，房间锁的单次持有时长因此有确定上界，而不是「上游有多慢就锁多久」。
  const resolveBudget = getLockBudget(roomId)

  let resolved = { ...track }

  // Local URLs are short-lived signed URLs. Resolve a fresh canonical Track
  // every time playback starts so an old queue item cannot expire silently.
  if (resolved.source === 'local') {
    const refreshed = await refreshLocalTrack(roomId, resolved)
    if (!refreshed) {
      queueService.removeTrack(roomId, resolved.id)
      io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: [resolved.id] })
      io.to(roomId).emit(EVENTS.ROOM_ERROR, {
        code: ERROR_CODE.LOCAL_AUDIO_NOT_FOUND,
        message: `本地歌曲「${resolved.title}」已被删除，已从列表移除`,
      })
      return false
    }
    resolved = refreshed
    const localIndex = room.queue.findIndex((candidate) => candidate.id === resolved.id)
    if (localIndex >= 0) {
      room.queue[localIndex] = resolved
      io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'replace', track: resolved, atIndex: localIndex })
    }
  }

  // Fetch stream URL if missing
  if (!resolved.streamUrl && resolved.source !== 'local') {
    const onlineSource = resolved.source
    try {
      // Get cookie from the room's pool for this platform (enables VIP access)
      const cookie = authService.getAnyCookie(onlineSource, roomId)
      const streamResult = await resolveStreamUrl(
        onlineSource,
        resolved.urlId,
        room.audioQuality,
        cookie ?? undefined,
        resolveBudget,
      )
      const url = streamResult.url

      if (!url) {
        const isVip = resolved.vip
        const { hint, reasonType } = streamFailureHint(onlineSource, streamResult.reason, {
          isVip,
          hasCookie: Boolean(cookie),
          detail: streamResult.detail,
        })
        logger.warn(`Cannot get stream URL for "${resolved.title}"${hint}, removing from queue`, {
          roomId,
          reason: streamResult.reason,
        })

        // -------------------------------------------------------------------
        // Auto fallback (netease <-> tencent)
        // -------------------------------------------------------------------
        if (
          config.autoFallback.enabled &&
          (onlineSource === 'netease' || onlineSource === 'tencent') &&
          canAutoFallback(roomId, resolved.id)
        ) {
          // Prevent repeated fallback attempts for this queue item
          markAutoFallback(roomId, resolved.id, 60_000)
          const fromSource = onlineSource
          const trackTitle = resolved.title
          const toSource = trackFallbackService.getFallbackTargetSource(fromSource)
          if (toSource) {
            const attemptId = nanoid()
            io.to(roomId).emit(EVENTS.ROOM_AUTO_FALLBACK, {
              attemptId,
              status: 'trying',
              fromSource,
              toSource,
              trackTitle,
              reasonType,
              reasonDetail: streamResult.detail,
            })

            try {
              // 换源搜索同样消耗共享预算：否则一个慢搜索就能把房间锁再拖长 15s。
              const fallbackSearch = await raceBudget(
                resolveBudget,
                trackFallbackService.findBestAlternativeTrack(resolved, toSource),
              )
              if (!fallbackSearch.ok) {
                logger.warn(`Auto fallback search skipped/exhausted for "${resolved.title}"`, { roomId })
              }
              const best = fallbackSearch.ok ? fallbackSearch.value : null
              if (best && best.track.source !== 'local') {
                const cookie2 = authService.getAnyCookie(best.track.source, roomId)
                const streamResult2 = await resolveStreamUrl(
                  best.track.source,
                  best.track.urlId,
                  room.audioQuality,
                  cookie2 ?? undefined,
                  resolveBudget,
                )
                const url2 = streamResult2.url
                if (url2) {
                  const replacement: Track = {
                    ...best.track,
                    id: resolved.id, // keep stable id so queue/current references remain consistent
                    requestedBy: resolved.requestedBy,
                    streamUrl: url2,
                    fallbackStreamUrl: streamResult2.backupUrl,
                  }

                  // Replace in queue (if present) before playing
                  const roomBefore = roomRepo.get(roomId)
                  if (roomBefore) {
                    const replaceIndex = roomBefore.queue.findIndex((t) => t.id === resolved.id)
                    if (replaceIndex >= 0) {
                      roomBefore.queue[replaceIndex] = replacement
                      io.to(roomId).emit(EVENTS.QUEUE_UPDATED, {
                        type: 'replace',
                        track: replacement,
                        atIndex: replaceIndex,
                      })
                    }
                  }

                  io.to(roomId).emit(EVENTS.ROOM_AUTO_FALLBACK, {
                    attemptId,
                    status: 'success',
                    fromSource,
                    toSource,
                    trackTitle,
                  })

                  // Continue playback with replacement
                  resolved.source = replacement.source
                  resolved.sourceId = replacement.sourceId
                  resolved.urlId = replacement.urlId
                  resolved.lyricId = replacement.lyricId
                  resolved.picId = replacement.picId
                  resolved.vip = replacement.vip
                  resolved.album = replacement.album
                  resolved.artist = replacement.artist
                  resolved.title = replacement.title
                  resolved.cover = replacement.cover
                  resolved.streamUrl = replacement.streamUrl
                  resolved.fallbackStreamUrl = replacement.fallbackStreamUrl
                }
              }
            } catch (fallbackErr) {
              logger.error('Auto fallback failed', fallbackErr, { roomId })
            }

            if (!resolved.streamUrl) {
              io.to(roomId).emit(EVENTS.ROOM_AUTO_FALLBACK, {
                attemptId,
                status: 'failed',
                fromSource,
                toSource,
                trackTitle,
                reasonType,
              })
            }
          }
        }

        // If still no streamUrl, follow original failure path
        if (!resolved.streamUrl) {
          // Auto-remove the invalid track from the queue
          queueService.removeTrack(roomId, resolved.id)
          io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: [resolved.id] })
          io.to(roomId).emit(EVENTS.ROOM_ERROR, {
            code: ERROR_CODE.STREAM_FAILED,
            message: `无法获取「${resolved.title}」的播放链接${hint}，已从列表移除`,
          })
          return false
        }
      }
      resolved.streamUrl = url ?? resolved.streamUrl
      if (streamResult.backupUrl) {
        resolved.fallbackStreamUrl = streamResult.backupUrl
      }
      // bilibili 音频直连 CDN 会被 Referer 校验拒绝（浏览器媒体请求只带页面 Referer），
      // 统一改走服务端代理；备用 CDN 由代理内部切换，不再下发给客户端。
      if (onlineSource === 'bilibili' && resolved.streamUrl) {
        const proxyParams = new URLSearchParams({ id: resolved.urlId })
        if (resolved.bilibiliCid) proxyParams.set('cid', String(resolved.bilibiliCid))
        proxyParams.set('bitrate', String(room.audioQuality))
        resolved.streamUrl = `/api/music/bilibili/stream?${proxyParams.toString()}`
        resolved.fallbackStreamUrl = undefined
      }
      // bandcamp：音频 CDN（bcbits）无 Referer 校验且大陆可直连，直连为主以节省
      // 服务器带宽；流地址 token 时效短，过期时客户端经 fallback 代理重新解析。
      if (onlineSource === 'bandcamp' && resolved.streamUrl) {
        const proxyParams = new URLSearchParams({ id: resolved.streamUrl, bitrate: String(room.audioQuality) })
        resolved.fallbackStreamUrl = `/api/music/bandcamp/stream?${proxyParams.toString()}`
      }
    } catch (err) {
      logger.error(`getStreamUrl failed for ${resolved.urlId}`, err, { roomId })
      // Auto-remove on unexpected failure too
      queueService.removeTrack(roomId, resolved.id)
      io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: [resolved.id] })
      return false
    }
  }

  // Fetch cover if missing. Cover 只是展示信息：它过去会和流解析一样无限期占住
  // 房间锁（上游封面接口同样可能挂死），现在共用锁预算，超时就放弃封面。
  if (resolved.source !== 'local' && !resolved.cover && resolved.picId) {
    try {
      const coverOutcome = await raceBudget(resolveBudget, musicProvider.getCover(resolved.source, resolved.picId))
      if (coverOutcome.ok && coverOutcome.value) resolved.cover = coverOutcome.value
    } catch {
      // Non-critical, leave cover empty
    }
  }

  // Update room state — align serverTimestamp with the scheduled execution time
  // so that estimateCurrentTime() is accurate before the first conductor report.
  room.currentTrack = resolved
  const scheduleTime = getScheduleTime(roomId)
  room.playState = {
    isPlaying: true,
    currentTime: 0,
    serverTimestamp: scheduleTime,
  }

  io.to(roomId).emit(EVENTS.PLAYER_PLAY, {
    track: resolved,
    playState: scheduled(room.playState, roomId, scheduleTime),
  })

  // 通知大厅用户当前播放曲目变化
  broadcastRoomList(io)

  logger.info(`Playing: ${resolved.title} in room ${roomId}`, { roomId })
  return true
}

export async function resumeTrack(io: TypedServer, roomId: string, _initiatorSocket?: TypedSocket): Promise<void> {
  const room = roomRepo.get(roomId)
  if (!room || !room.currentTrack) return

  if (room.currentTrack.source === 'local') {
    const expectedTrack = room.currentTrack
    const expectedPlayState = room.playState
    const refreshed = await refreshLocalTrack(roomId, expectedTrack, true)
    // A next/play/pause/seek action may have won while the dynamic local-audio
    // lookup was pending. Never let this stale resume overwrite newer state.
    if (roomRepo.get(roomId) !== room || room.currentTrack !== expectedTrack || room.playState !== expectedPlayState) {
      return
    }
    if (!refreshed) {
      await playNextTrackInRoom(io, roomId, room.playMode, { skipDebounce: true, skipHistory: true })
      return
    }
    room.currentTrack = refreshed
    const queueIndex = room.queue.findIndex((track) => track.id === refreshed.id)
    if (queueIndex >= 0) room.queue[queueIndex] = refreshed
  }

  // If the current track has no streamUrl, re-resolve it instead of just
  // flipping isPlaying (the client has no Howl instance and would silently
  // ignore the RESUME event).  This can happen after long uptime when a
  // previously resolved URL expired or was lost in a race.
  if (!room.currentTrack.streamUrl) {
    logger.warn(`resumeTrack: currentTrack "${room.currentTrack.title}" has no streamUrl — re-resolving`, { roomId })
    const ok = await playTrackInRoom(io, roomId, room.currentTrack)
    if (!ok) {
      // Re-resolution also failed — skip to next track to unstick the room
      logger.warn(`resumeTrack: re-resolution failed, skipping to next track`, { roomId })
      await playNextTrackInRoom(io, roomId, room.playMode, { skipDebounce: true })
    }
    return
  }

  const scheduleTime = getScheduleTime(roomId)
  room.playState = { ...room.playState, isPlaying: true, serverTimestamp: scheduleTime }
  // All clients (including initiator) must execute at the same scheduled moment
  io.to(roomId).emit(EVENTS.PLAYER_RESUME, {
    playState: scheduled(room.playState, roomId, scheduleTime),
    // Each client decides whether its currently loaded signed URL will remain
    // valid for the rest of the recording. Only stale clients reload.
    track: room.currentTrack.source === 'local' ? room.currentTrack : undefined,
  })
}

export function pauseTrack(io: TypedServer, roomId: string, _initiatorSocket?: TypedSocket): void {
  const room = roomRepo.get(roomId)
  if (!room) return

  // Snapshot estimated position before pausing so resume starts from the correct point
  const snapshotTime = estimateCurrentTime(roomId)
  room.playState = { isPlaying: false, currentTime: snapshotTime, serverTimestamp: Date.now() }
  // All clients must pause at the same scheduled moment
  io.to(roomId).emit(EVENTS.PLAYER_PAUSE, { playState: scheduled(room.playState, roomId) })
}

export function seekTrack(io: TypedServer, roomId: string, currentTime: number, _initiatorSocket?: TypedSocket): void {
  const room = roomRepo.get(roomId)
  if (!room) return

  const scheduleTime = getScheduleTime(roomId)
  // When playing, align serverTimestamp with scheduled time so estimateCurrentTime() is accurate
  room.playState = {
    ...room.playState,
    currentTime,
    serverTimestamp: room.playState.isPlaying ? scheduleTime : Date.now(),
  }
  // All clients must seek at the same scheduled moment
  io.to(roomId).emit(EVENTS.PLAYER_SEEK, { playState: scheduled(room.playState, roomId, scheduleTime) })
}

export function updatePlayState(roomId: string, update: Partial<PlayState>): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.playState = { ...room.playState, ...update, serverTimestamp: Date.now() }
  }
}

export function setCurrentTrack(roomId: string, track: Track | null): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.currentTrack = track
    room.playState = {
      isPlaying: track !== null,
      currentTime: 0,
      serverTimestamp: Date.now(),
    }
  }
}

/**
 * Stop playback: clear current track, emit PLAYER_PAUSE with a stopped state,
 * broadcast full ROOM_STATE so clients clear stale track, and notify lobby.
 * Used when no next track is available (queue empty, track removed, queue cleared).
 */
export function stopPlayback(io: TypedServer, roomId: string): void {
  setCurrentTrack(roomId, null)
  io.to(roomId).emit(EVENTS.PLAYER_PAUSE, {
    playState: { isPlaying: false, currentTime: 0, serverTimestamp: Date.now(), serverTimeToExecute: Date.now() },
  })
  const room = roomRepo.get(roomId)
  if (room) {
    io.to(roomId).emit(EVENTS.ROOM_STATE, toPublicRoomState(room))
  }
  broadcastRoomList(io)
}

/**
 * Mutex-protected variant of `stopPlayback`. Use when the caller is NOT
 * already inside the per-room mutex (e.g. QUEUE_CLEAR) to prevent races
 * with concurrent `autoPlayIfEmpty` / `_playTrackInRoom` operations.
 */
export function stopPlaybackSafe(io: TypedServer, roomId: string): Promise<void> {
  return withPlayMutex(roomId, async () => {
    stopPlayback(io, roomId)
  })
}

// ---------------------------------------------------------------------------
// Next / Previous track (debounce + queue navigation inside mutex)
// ---------------------------------------------------------------------------

/**
 * Advance to the next track in the queue. Debounce check and queue navigation
 * run inside the per-room mutex so two rapid NEXT events can never both pass
 * the debounce in the same event loop tick.
 */
export function playNextTrackInRoom(
  io: TypedServer,
  roomId: string,
  playMode: PlayMode,
  options?: {
    skipDebounce?: boolean
    previousIndex?: number
    currentAlreadyRemoved?: boolean
    skipHistory?: boolean
    stopBeforeResolve?: boolean
  },
): Promise<void> {
  return withPlayMutex(roomId, async () => {
    // Guard: if a NEXT is already in progress for this room, drop this event.
    // Prevents concurrent _playTrackInRoom calls when stream URL resolution
    // takes longer than the debounce window (500ms).
    if (!options?.skipDebounce && nextAdvancing.has(roomId)) {
      return
    }

    if (options?.skipDebounce) {
      // Still update the timestamp so a normal NEXT right after is debounced
      lastNextTimestamp.set(roomId, Date.now())
    } else if (_isNextDebounced(roomId)) {
      return
    }

    nextAdvancing.add(roomId)
    try {
      await _executePlayNext(io, roomId, playMode, options)
    } finally {
      nextAdvancing.delete(roomId)
      // Refresh debounce timestamp after async work completes.
      // Without this, a second PLAYER_NEXT waiting on the mutex could pass
      // the debounce check if _playTrackInRoom took longer than 500ms (e.g.
      // stream URL resolution), causing a double-skip.
      lastNextTimestamp.set(roomId, Date.now())
    }
  })
}

/**
 * Execute the next-track logic (inside mutex, guarded by nextAdvancing).
 * Extracted so the try/finally in playNextTrackInRoom covers the full async
 * operation including _playTrackInRoom and fallback.
 */
async function _executePlayNext(
  io: TypedServer,
  roomId: string,
  playMode: PlayMode,
  options?: {
    skipDebounce?: boolean
    previousIndex?: number
    currentAlreadyRemoved?: boolean
    skipHistory?: boolean
    stopBeforeResolve?: boolean
  },
): Promise<void> {
  const room = roomRepo.get(roomId)
  if (!room) return

  // Capture current state BEFORE any mutations so we can compute the next
  // track correctly even after auto-removing the current one from the queue.
  const currentTrack = room.currentTrack
  const oldCurrentIndex =
    options?.previousIndex ?? (currentTrack ? room.queue.findIndex((t) => t.id === currentTrack.id) : -1)

  // Destructive local-file deletion must stop the buffered old track before
  // resolving the next stream URL. Keep the captured track/index above so the
  // queue transition remains correct after stopPlayback clears currentTrack.
  if (options?.stopBeforeResolve && currentTrack) stopPlayback(io, roomId)

  // Record finished track to play history (regardless of autoRemovePlayed)
  if (currentTrack && !options?.skipHistory) {
    const entry: PlayedTrack = {
      track: currentTrack,
      playedAt: Date.now(),
      requestedBy: currentTrack.requestedBy,
    }
    room.playedHistory.push(entry)
    if (room.playedHistory.length > LIMITS.PLAYED_HISTORY_MAX_SIZE) {
      room.playedHistory = room.playedHistory.slice(-LIMITS.PLAYED_HISTORY_MAX_SIZE)
    }
    io.to(roomId).emit(EVENTS.PLAYED_HISTORY_UPDATED, { playedHistory: room.playedHistory })
  }

  // Auto-remove played track from queue (if enabled AND track is still in queue)
  const autoRemoved =
    !options?.currentAlreadyRemoved && !!(room.autoRemovePlayed && currentTrack && oldCurrentIndex >= 0)
  if (autoRemoved) {
    room.queue = room.queue.filter((t) => t.id !== currentTrack.id)
    io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: [currentTrack.id] })
  }

  // In like mode, bypass index-based selection and pick by popularity.
  // Otherwise compute next track index using the OLD current index, but
  // on the (possibly shorter) queue.  When the track at oldCurrentIndex
  // was removed, the element that was at oldCurrentIndex+1 is now at
  // oldCurrentIndex — so the "next" is exactly oldCurrentIndex.
  let nextTrack: Track | null = null
  if (room.songLikes && room.autoRemovePlayed) {
    nextTrack = queueService.getNextTrackByLikes(roomId, playMode)
  } else {
    const previousRemoved = Boolean(options?.currentAlreadyRemoved || autoRemoved)
    const nextIndex = queueService.computeNextIndex(roomId, playMode, oldCurrentIndex, previousRemoved)
    nextTrack = nextIndex >= 0 ? room.queue[nextIndex] : null
  }

  if (!nextTrack) {
    // Fallback: if default queue is configured, randomly pick one and play
    const picked = await pickFromDefaultQueue(io, roomId)
    if (picked) {
      const success = await _playTrackInRoom(io, roomId, picked)
      if (!success) {
        // _playTrackInRoom failed (e.g. stream URL could not be resolved).
        // Retry with a different random pick instead of stopping playback,
        // so a single dead track doesn't stall the room.
        logger.warn(`Default queue track "${picked.title}" failed to play, trying another`, { roomId })
        playNextTrackInRoom(io, roomId, playMode, { skipDebounce: true })
        return
      }
      lastNextTimestamp.set(roomId, Date.now())
      return
    }
    stopPlayback(io, roomId)
    return
  }

  const success = await _playTrackInRoom(io, roomId, nextTrack)
  if (!success) {
    // After a failed play, re-compute fallback normally (currentTrack is
    // already set to the failed track by _playTrackInRoom; skipDebounce
    // not needed since it was already cleared by the first call).
    const fallbackTrack = queueService.getNextTrack(roomId, playMode)
    if (fallbackTrack && (await _playTrackInRoom(io, roomId, fallbackTrack))) return
    // A pending-delete local asset may have been the only loop-one/loop-all
    // candidate. Once both the candidate and fallback are unavailable, clear
    // currentTrack so physical deletion is no longer pinned forever.
    stopPlayback(io, roomId)
  }
}

/**
 * Go to the previous track in the queue. Same mutex serialization as next.
 */
export function playPrevTrackInRoom(
  io: TypedServer,
  roomId: string,
  options?: { skipDebounce?: boolean },
): Promise<void> {
  return withPlayMutex(roomId, async () => {
    if (options?.skipDebounce) {
      lastNextTimestamp.set(roomId, Date.now())
    } else if (_isNextDebounced(roomId)) {
      return
    }

    const prevTrack = queueService.getPreviousTrack(roomId)
    if (!prevTrack) return

    const success = await _playTrackInRoom(io, roomId, prevTrack)
    if (!success) {
      const skipTrack = queueService.getPreviousTrack(roomId)
      if (skipTrack) await _playTrackInRoom(io, roomId, skipTrack)
    }

    // Refresh debounce timestamp after async work (same rationale as playNextTrackInRoom)
    lastNextTimestamp.set(roomId, Date.now())
  })
}

// ---------------------------------------------------------------------------
// Playback sync for newly-joined clients
// ---------------------------------------------------------------------------

/** 单次接续播放时最多尝试补全的默认列表条目数（防止全坏列表导致无限循环）。 */
const DEFAULT_QUEUE_PICK_MAX_ATTEMPTS = 5

/**
 * 主队列为空且默认播放列表非空时，随机抽一条引用、补全为完整 Track 后加入主队列并广播。
 * 补全失败（平台下架/本地资产消失）的条目会被移除并广播通知，避免后续每次兜底都卡在该条目上。
 *
 * 该函数可能在持有房间播放锁时被调用（`_executePlayNext` 的接续播放），因此
 * `DEFAULT_QUEUE_PICK_MAX_ATTEMPTS` 次补全共享一个硬预算——否则一个慢的上游
 * 详情接口会让「最多 5 次尝试」变成 5 × 单次上限，重新把房间锁拉长。
 */
async function pickFromDefaultQueue(io: TypedServer, roomId: string): Promise<Track | null> {
  const pickBudget = getLockBudget(roomId)
  for (let attempt = 0; attempt < DEFAULT_QUEUE_PICK_MAX_ATTEMPTS; attempt++) {
    if (pickBudget.remainingMs() <= 0) {
      logger.warn(`Default queue pick budget exhausted for room ${roomId}`, { roomId })
      return null
    }
    const room = roomRepo.get(roomId)
    if (!room || room.defaultQueue.length === 0) return null
    const index = Math.floor(Math.random() * room.defaultQueue.length)
    const ref = room.defaultQueue[index]!
    const pickOutcome = await raceBudget(pickBudget, resolveDefaultQueueRef(roomId, ref))
    if (!pickOutcome.ok) {
      // 超时只代表上游太慢，不代表这条引用失效：不能删除它，也不能继续循环。
      logger.warn(`Default queue ref resolution timed out, aborting pick: ${ref.source}/${ref.sourceId}`, { roomId })
      return null
    }
    if (pickOutcome.value) {
      const resolved = pickOutcome.value
      const added = queueService.addTrack(roomId, resolved)
      if (!added) return null
      io.to(roomId).emit(EVENTS.QUEUE_UPDATED, {
        type: 'insert',
        tracks: [resolved],
        atIndex: room.queue.length - 1,
      })
      return room.queue[room.queue.length - 1] ?? null
    }

    room.defaultQueue.splice(index, 1)
    io.to(roomId).emit(EVENTS.DEFAULT_QUEUE_DELTA, { type: 'remove', trackIds: [ref.id] })
    const msg = chatService.createSystemMessage(roomId, `「${ref.title}」已无法解析，已从默认播放列表移除`)
    io.to(roomId).emit(EVENTS.CHAT_MESSAGE, msg)
    logger.warn(`Default queue ref resolution failed, removed: ${ref.source}/${ref.sourceId}`, { roomId })
  }
  return null
}

/**
 * 主队列为空时从默认播放列表随机取一首加入并播放。
 * 供 QUEUE_CLEAR 等场景在清空队列后接续播放；没有可用歌曲时返回 false。
 */
export async function playFromDefaultQueue(io: TypedServer, roomId: string): Promise<boolean> {
  const picked = await pickFromDefaultQueue(io, roomId)
  if (!picked) return false
  return playTrackInRoom(io, roomId, picked)
}

/**
 * Send current playback state to a socket that just joined a room.
 * Handles auto-resume when alone, and auto-play from queue.
 */
export async function syncPlaybackToSocket(
  io: TypedServer,
  socket: TypedSocket,
  roomId: string,
  room: RoomData,
): Promise<void> {
  const isAloneInRoom = room.users.length === 1

  if (room.currentTrack?.source === 'local') {
    const refreshed = await refreshLocalTrack(roomId, room.currentTrack, true)
    if (refreshed) {
      room.currentTrack = refreshed
      const queueIndex = room.queue.findIndex((track) => track.id === refreshed.id)
      if (queueIndex >= 0) room.queue[queueIndex] = refreshed
    }
  }

  if (room.currentTrack?.streamUrl) {
    // Alone in room + track was paused → auto-resume (user rejoining)
    const shouldAutoPlay = isAloneInRoom || room.playState.isPlaying
    if (isAloneInRoom && !room.playState.isPlaying) {
      room.playState = { ...room.playState, isPlaying: true, serverTimestamp: Date.now() }
    }

    const snapshotCurrentTime = estimateCurrentTime(roomId)
    const snapshotTimestamp = Date.now()
    const joinCalibrationDelayMs = NTP.INITIAL_INTERVAL_MS * NTP.MAX_INITIAL_SAMPLES + 100
    const scheduleTime = shouldAutoPlay
      ? Math.max(getScheduleTime(roomId), snapshotTimestamp + joinCalibrationDelayMs)
      : snapshotTimestamp
    const delaySec = shouldAutoPlay ? Math.max(0, (scheduleTime - snapshotTimestamp) / 1000) : 0

    socket.emit(EVENTS.PLAYER_PLAY, {
      track: room.currentTrack,
      playState: {
        isPlaying: shouldAutoPlay,
        currentTime: snapshotCurrentTime + delaySec,
        serverTimestamp: scheduleTime,
        serverTimeToExecute: scheduleTime,
      },
    })
  } else if (isAloneInRoom && room.queue.length > 0) {
    // No current track but queue has items → start playing from queue
    const firstTrack = room.queue[0]
    await playTrackInRoom(io, roomId, firstTrack)
  } else if (isAloneInRoom) {
    // No current track, queue empty, but default queue has items → random pick
    const picked = await pickFromDefaultQueue(io, roomId)
    if (picked) await playTrackInRoom(io, roomId, picked)
  }
}

// ---------------------------------------------------------------------------
// Room cleanup, debounce & conductor report validation
// ---------------------------------------------------------------------------

/** Debounce tracking for PLAYER_NEXT per room */
const lastNextTimestamp = new Map<string, number>()

/** Set of rooms currently advancing to the next track (prevents concurrent PLAYER_NEXT) */
const nextAdvancing = new Set<string>()

/** Track consecutive rejected conductor reports per room to break deadlocks */
const conductorRejectCount = new Map<string, number>()

/** Force-accept a conductor report after this many consecutive rejections */
const CONDUCTOR_REJECT_FORCE_ACCEPT_COUNT = 2

/** Max allowed drift (seconds) between conductor-reported time and server estimate */
const CONDUCTOR_REJECT_DRIFT_THRESHOLD_S = 3

/** Remove per-room entries for a deleted room */
export function cleanupRoom(roomId: string): void {
  lastNextTimestamp.delete(roomId)
  nextAdvancing.delete(roomId)
  conductorRejectCount.delete(roomId)
  playMutexes.delete(roomId)
  roomLockBudgets.delete(roomId)
}

/**
 * Validate a conductor sync report against the server estimate.
 * Returns true if the report should be ACCEPTED, false if rejected (stale).
 * Automatically force-accepts after CONDUCTOR_REJECT_FORCE_ACCEPT consecutive
 * rejections to break deadlocks when the server estimate has diverged.
 */
export function validateConductorReport(roomId: string, reportedTime: number, estimatedTime: number): boolean {
  if (estimatedTime - reportedTime > CONDUCTOR_REJECT_DRIFT_THRESHOLD_S) {
    const count = (conductorRejectCount.get(roomId) ?? 0) + 1
    conductorRejectCount.set(roomId, count)
    if (count < CONDUCTOR_REJECT_FORCE_ACCEPT_COUNT) {
      return false // reject
    }
    // Too many consecutive rejections — force accept to break deadlock
    logger.warn(`Force-accepting conductor report after ${count} consecutive rejections`, { roomId })
  }
  // Accepted — reset counter
  conductorRejectCount.delete(roomId)
  return true
}

/**
 * Check and update the next-track debounce for a room.
 * Returns true if the action should be SKIPPED (too soon), false if allowed.
 * Internal: called inside mutex to prevent same-tick race conditions.
 */
function _isNextDebounced(roomId: string): boolean {
  const now = Date.now()
  const lastNext = lastNextTimestamp.get(roomId) ?? 0
  if (now - lastNext < config.player.nextDebounceMs) return true
  lastNextTimestamp.set(roomId, now)
  return false
}
