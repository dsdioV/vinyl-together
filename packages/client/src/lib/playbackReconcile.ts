import type { PlayState } from '@music-together/shared'

/**
 * 播放对账（playback reconciliation）纯逻辑。
 *
 * 背景：客户端只依赖 PLAYER_PLAY / RESUME / PAUSE / SEEK 事件推进本地播放器。
 * 弱网（请求挂起、事件丢失、页面冻结）时本地状态可能与服务端永久脱钩：
 * 播放器停在上一首、或者媒体请求挂住导致 onload 永不触发 —— 此前没有任何
 * 超时或对账机制，只能刷新页面（且刷新后仍可能再次挂住）。
 *
 * 这里把所有「什么时候该重试/重载」的判定抽成纯函数，配合 hooks 里的看门狗使用。
 */

/** 连续检测到轨道不一致多久才动手（避免与正常切歌竞争） */
export const RECONCILE_DEBOUNCE_MS = 2_000

/** 对账看门狗轮询间隔 */
export const RECONCILE_INTERVAL_MS = 2_000

/** 首次加载迟迟没有 onload（媒体请求挂起）→ 判定卡死的超时 */
export const INITIAL_LOAD_TIMEOUT_MS = 10_000

/** 已 onload 但迟迟没有 onplay（播放起不来）→ 判定卡死的超时 */
export const PLAYBACK_START_TIMEOUT_MS = 5_000

/** 房间在播、本地已加载却停着超过该时长 → 认为本地卡死 */
export const LOCAL_PAUSED_STUCK_MS = 8_000

/** 重新加载的指数退避（第 n 次尝试前的等待），避免弱网下高频重试 */
export const RECONCILE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000, 30_000] as const

/** 一次加载尝试的进度（由 useHowl 维护） */
export interface LoadProgress {
  trackId: string
  startedAt: number
  /** onload 是否已触发（拿到元数据/时长） */
  loaded: boolean
  /** onplay 是否已触发（真正开始出声） */
  playedOnce: boolean
}

export type TrackDesyncReason = 'missing-player' | 'track-mismatch'

/**
 * 本地播放器是否已与房间当前曲目脱钩。
 * - missing-player：房间有曲目，但本地没有播放器实例/曲目（刷新、加载失败）。
 * - track-mismatch：本地还停在别的曲目上（漏收切歌事件）。
 */
export function detectTrackDesync(input: {
  roomTrackId: string | null
  playerTrackId: string | null
  hasHowl: boolean
}): TrackDesyncReason | null {
  if (!input.roomTrackId) return null
  if (!input.playerTrackId || !input.hasHowl) return 'missing-player'
  if (input.playerTrackId !== input.roomTrackId) return 'track-mismatch'
  return null
}

/** 首次加载超时：媒体请求挂起时 onload/onloaderror 都可能永远不触发 */
export function isLoadStalled(
  load: LoadProgress | null,
  now: number,
  timeoutMs: number = INITIAL_LOAD_TIMEOUT_MS,
): boolean {
  if (!load || load.loaded) return false
  return now - load.startedAt >= timeoutMs
}

/** 已加载但播放起不来（例如解锁/解码失败却无事件） */
export function isPlaybackStartStalled(
  load: LoadProgress | null,
  now: number,
  timeoutMs: number = PLAYBACK_START_TIMEOUT_MS,
): boolean {
  if (!load || !load.loaded || load.playedOnce) return false
  return now - load.startedAt >= timeoutMs
}

/** 第 attempt 次重试前的等待时长 */
export function retryDelayForAttempt(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECONCILE_RETRY_DELAYS_MS.length - 1)
  return RECONCILE_RETRY_DELAYS_MS[index]
}

/** 退避窗口是否已过（lastAttemptAt = 0 表示还没重试过） */
export function mayRetry(lastAttemptAt: number, attempt: number, now: number): boolean {
  if (lastAttemptAt === 0) return true
  return now - lastAttemptAt >= retryDelayForAttempt(attempt)
}

/**
 * 估算房间当前应播位置（秒）：服务端以 playState 为准，播放中按 NTP 校准时间外推，
 * 并按曲目时长收敛，避免把位置算到曲末之后。
 */
export function estimateRoomPosition(
  playState: Pick<PlayState, 'isPlaying' | 'currentTime' | 'serverTimestamp'>,
  serverNow: number,
  duration?: number,
): number {
  const base = Math.max(0, playState.currentTime)
  const elapsed = playState.isPlaying ? Math.max(0, (serverNow - playState.serverTimestamp) / 1000) : 0
  const position = base + elapsed
  if (duration && duration > 0) return Math.min(position, duration)
  return position
}
