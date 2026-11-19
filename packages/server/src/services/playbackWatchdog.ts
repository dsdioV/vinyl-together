import type { TypedServer } from '../middleware/types.js'
import { roomRepo } from '../repositories/roomRepository.js'
import { estimateCurrentTime } from './syncService.js'
import { playNextTrackInRoom } from './playerService.js'
import { logger } from '../utils/logger.js'

/**
 * 房间级「曲末看门狗」。
 *
 * 自动切歌依赖 conductor（hostId）客户端在本地音频 onend 时发送 PLAYER_NEXT。
 * 如果 conductor 自己卡住（音频停住、事件丢失、标签页被系统冻结），服务端此前
 * 没有任何"这首歌已经播完"的兜底，整个房间会停在原地不再换歌 —— 这是客户端
 * 对账修复覆盖不到的第四类故障。
 *
 * 触发条件刻意保守，只在「明显异常」时动手：
 *   1. playState.isPlaying（房间认为在播）；
 *   2. 曲目时长已知且足够长（元数据不可靠的短曲不参与）；
 *   3. 估算播放位置已经越过曲末超过宽限时间；
 *   4. conductor 已静默超过阈值（正常播放时它每 2~5s 上报一次进度）。
 */

/** 参与判定的最小曲目时长（秒）：过短的曲目元数据不可靠，宁可不救也不误切 */
export const MIN_TRACK_DURATION_S = 30

/** 越过曲末后的宽限时间（秒） */
export const END_OF_TRACK_GRACE_S = 15

/** conductor 静默阈值（ms）：正常播放时每 2~5s 会通过 PLAYER_SYNC 上报一次 */
export const CONDUCTOR_SILENCE_MS = 15_000

/** 看门狗扫描周期（ms） */
export const WATCHDOG_INTERVAL_MS = 5_000

export interface PlaybackStallInput {
  /** 房间认为正在播放 */
  isPlaying: boolean
  /** playState 快照位置（秒） */
  currentTime: number
  /** playState 快照的服务端时间戳（ms） */
  serverTimestamp: number
  /** 当前曲目时长（秒），0/未知表示不可判定 */
  duration: number
  /** 房间内是否有用户在听 */
  userCount: number
  /** 当前服务端时间（ms） */
  now: number
}

/** 估算位置：快照位置 + 从快照至今的服务端耗时 */
export function estimateRawPosition(currentTime: number, serverTimestamp: number, now: number): number {
  return Math.max(0, currentTime) + Math.max(0, (now - serverTimestamp) / 1000)
}

/**
 * 房间是否已卡在曲末、需要强制推进到下一首。
 * 纯函数，便于单测覆盖各条边界（宁可不触发，也不要误切正在播的歌）。
 */
export function shouldForceAdvance(input: PlaybackStallInput): boolean {
  if (!input.isPlaying) return false
  if (input.userCount <= 0) return false
  if (!Number.isFinite(input.duration) || input.duration < MIN_TRACK_DURATION_S) return false
  // conductor 长时间没有上报进度：它可能已经停止播放/被冻结
  if (input.now - input.serverTimestamp < CONDUCTOR_SILENCE_MS) return false
  const position = estimateRawPosition(input.currentTime, input.serverTimestamp, input.now)
  return position > input.duration + END_OF_TRACK_GRACE_S
}

let timer: ReturnType<typeof setInterval> | null = null
/** 防止同一房间在探测期间重复触发 */
const advancing = new Set<string>()

async function sweep(io: TypedServer): Promise<void> {
  const now = Date.now()
  for (const roomId of roomRepo.getAllIds()) {
    const room = roomRepo.get(roomId)
    if (!room || !room.currentTrack) continue
    if (advancing.has(roomId)) continue
    const stalled = shouldForceAdvance({
      isPlaying: room.playState.isPlaying,
      currentTime: room.playState.currentTime,
      serverTimestamp: room.playState.serverTimestamp,
      duration: room.currentTrack.duration,
      userCount: room.users.length,
      now,
    })
    if (!stalled) continue

    const estimated = estimateCurrentTime(roomId)
    logger.warn(
      `Playback stalled at track end (room ${roomId}, "${room.currentTrack.title}" ${estimated.toFixed(1)}s / ${room.currentTrack.duration}s), advancing`,
      { roomId },
    )
    advancing.add(roomId)
    try {
      await playNextTrackInRoom(io, roomId, room.playMode)
    } catch (error) {
      logger.error('Playback watchdog failed to advance room', error, { roomId })
    } finally {
      advancing.delete(roomId)
    }
  }
}

/**
 * 启动曲末看门狗（幂等）。返回停止函数，供优雅关闭时清理。
 */
export function startPlaybackWatchdog(io: TypedServer): () => void {
  if (timer) return () => stopPlaybackWatchdog()
  timer = setInterval(() => {
    void sweep(io).catch((error) => logger.error('Playback watchdog sweep failed', error))
  }, WATCHDOG_INTERVAL_MS)
  // 不要因为看门狗阻止进程退出
  timer.unref?.()
  return () => stopPlaybackWatchdog()
}

export function stopPlaybackWatchdog(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  advancing.clear()
}
