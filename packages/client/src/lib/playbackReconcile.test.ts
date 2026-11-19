import { describe, expect, it } from 'vitest'
import {
  detectTrackDesync,
  estimateRoomPosition,
  isLoadStalled,
  isPlaybackStartStalled,
  mayRetry,
  retryDelayForAttempt,
  INITIAL_LOAD_TIMEOUT_MS,
  RECONCILE_RETRY_DELAYS_MS,
  type LoadProgress,
} from './playbackReconcile'

const load = (over: Partial<LoadProgress> = {}): LoadProgress => ({
  trackId: 't1',
  startedAt: 1_000,
  loaded: false,
  playedOnce: false,
  ...over,
})

describe('detectTrackDesync', () => {
  it('无房间曲目时不判定脱钩', () => {
    expect(detectTrackDesync({ roomTrackId: null, playerTrackId: 't1', hasHowl: true })).toBeNull()
  })

  it('本地没有播放器实例 → missing-player', () => {
    expect(detectTrackDesync({ roomTrackId: 'b', playerTrackId: null, hasHowl: false })).toBe('missing-player')
  })

  it('有播放器但 howl 已被卸载 → missing-player', () => {
    expect(detectTrackDesync({ roomTrackId: 'b', playerTrackId: 'b', hasHowl: false })).toBe('missing-player')
  })

  it('本地仍停在上一首 → track-mismatch', () => {
    expect(detectTrackDesync({ roomTrackId: 'b', playerTrackId: 'a', hasHowl: true })).toBe('track-mismatch')
  })

  it('一致时不动作', () => {
    expect(detectTrackDesync({ roomTrackId: 'b', playerTrackId: 'b', hasHowl: true })).toBeNull()
  })
})

describe('isLoadStalled', () => {
  it('未超时不触发', () => {
    expect(isLoadStalled(load(), 1_000 + INITIAL_LOAD_TIMEOUT_MS - 1)).toBe(false)
  })

  it('超时且未 loaded → 卡死（媒体请求挂起的情形）', () => {
    expect(isLoadStalled(load(), 1_000 + INITIAL_LOAD_TIMEOUT_MS)).toBe(true)
  })

  it('已 loaded 不算卡死', () => {
    expect(isLoadStalled(load({ loaded: true }), 1_000 + INITIAL_LOAD_TIMEOUT_MS * 10)).toBe(false)
  })

  it('没有加载记录时不触发', () => {
    expect(isLoadStalled(null, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})

describe('isPlaybackStartStalled', () => {
  it('已 loaded 但未 playedOnce 且超时 → 卡死', () => {
    expect(isPlaybackStartStalled(load({ loaded: true }), 1_000 + 5_000)).toBe(true)
  })

  it('已开始播放则不算', () => {
    expect(isPlaybackStartStalled(load({ loaded: true, playedOnce: true }), 1_000 + 60_000)).toBe(false)
  })

  it('尚未 loaded 时由 isLoadStalled 负责', () => {
    expect(isPlaybackStartStalled(load(), 1_000 + 60_000)).toBe(false)
  })
})

describe('retry backoff', () => {
  it('尝试次数递增时等待变长，并在最后一档封顶', () => {
    expect(retryDelayForAttempt(0)).toBe(RECONCILE_RETRY_DELAYS_MS[0])
    expect(retryDelayForAttempt(2)).toBe(RECONCILE_RETRY_DELAYS_MS[2])
    expect(retryDelayForAttempt(99)).toBe(RECONCILE_RETRY_DELAYS_MS[RECONCILE_RETRY_DELAYS_MS.length - 1])
    expect(retryDelayForAttempt(-3)).toBe(RECONCILE_RETRY_DELAYS_MS[0])
  })

  it('首次总是允许重试，之后按退避窗口判断', () => {
    expect(mayRetry(0, 0, 10_000)).toBe(true)
    expect(mayRetry(10_000, 0, 10_000 + RECONCILE_RETRY_DELAYS_MS[0] - 1)).toBe(false)
    expect(mayRetry(10_000, 0, 10_000 + RECONCILE_RETRY_DELAYS_MS[0])).toBe(true)
  })
})

describe('estimateRoomPosition', () => {
  it('暂停时返回快照位置', () => {
    expect(estimateRoomPosition({ isPlaying: false, currentTime: 42, serverTimestamp: 0 }, 999_999)).toBe(42)
  })

  it('播放中按服务端时间外推', () => {
    expect(estimateRoomPosition({ isPlaying: true, currentTime: 10, serverTimestamp: 5_000 }, 8_000)).toBe(13)
  })

  it('serverTimestamp 未来（调度时刻）时不倒推', () => {
    expect(estimateRoomPosition({ isPlaying: true, currentTime: 10, serverTimestamp: 9_000 }, 5_000)).toBe(10)
  })

  it('按曲目时长收敛，避免超出曲末', () => {
    expect(estimateRoomPosition({ isPlaying: true, currentTime: 10, serverTimestamp: 0 }, 60_000, 30)).toBe(30)
  })

  it('时长为 0/未知时不收敛', () => {
    expect(estimateRoomPosition({ isPlaying: true, currentTime: 0, serverTimestamp: 0 }, 5_000, 0)).toBe(5)
  })
})
