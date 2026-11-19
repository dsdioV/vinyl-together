import { describe, expect, it } from 'vitest'
import {
  CONDUCTOR_SILENCE_MS,
  END_OF_TRACK_GRACE_S,
  MIN_TRACK_DURATION_S,
  estimateRawPosition,
  shouldForceAdvance,
  type PlaybackStallInput,
} from './playbackWatchdog'

const NOW = 1_000_000

const base = (over: Partial<PlaybackStallInput> = {}): PlaybackStallInput => ({
  isPlaying: true,
  currentTime: 30,
  // conductor 3s 前刚上报过（正常播放）
  serverTimestamp: NOW - 3_000,
  duration: 180,
  userCount: 1,
  now: NOW,
  ...over,
})

describe('estimateRawPosition', () => {
  it('按服务端耗时外推', () => {
    expect(estimateRawPosition(10, 1_000, 4_000)).toBe(13)
  })

  it('时间戳在未来时不倒推', () => {
    expect(estimateRawPosition(10, 5_000, 1_000)).toBe(10)
  })
})

describe('shouldForceAdvance', () => {
  it('正常播放中不触发', () => {
    expect(shouldForceAdvance(base())).toBe(false)
  })

  it('当前未播放不触发（暂停不能当成卡死）', () => {
    expect(shouldForceAdvance(base({ isPlaying: false }))).toBe(false)
  })

  it('房间没人不触发', () => {
    expect(shouldForceAdvance(base({ userCount: 0 }))).toBe(false)
  })

  it('时长未知/过短不触发（元数据不可靠）', () => {
    expect(shouldForceAdvance(base({ duration: 0 }))).toBe(false)
    expect(shouldForceAdvance(base({ duration: MIN_TRACK_DURATION_S - 1 }))).toBe(false)
  })

  it('刚越过曲末、conductor 仍在正常上报时不触发（可能是元数据偏差）', () => {
    expect(
      shouldForceAdvance(
        base({
          currentTime: 200,
          serverTimestamp: NOW - 1_000,
          // 已越过曲末，但 conductor 6s 前刚上报（< 静默阈值）
          now: NOW + 5_000,
        }),
      ),
    ).toBe(false)
  })

  it('conductor 静默且已越过曲末宽限 → 触发', () => {
    // 位置 180 + 20 = 200 秒 > 180 + 15，且已静默 20s
    expect(
      shouldForceAdvance(
        base({
          currentTime: 180,
          serverTimestamp: NOW - 20_000,
        }),
      ),
    ).toBe(true)
  })

  it('conductor 静默但尚未越过曲末 → 不触发', () => {
    expect(
      shouldForceAdvance(
        base({
          currentTime: 100,
          serverTimestamp: NOW - 20_000,
        }),
      ),
    ).toBe(false)
  })

  it('曲末宽限内不触发', () => {
    // 位置 170 + 20 = 190 秒，未超过 180 + 15
    expect(
      shouldForceAdvance(
        base({
          currentTime: 170,
          serverTimestamp: NOW - 20_000,
        }),
      ),
    ).toBe(false)
    expect(
      shouldForceAdvance(
        base({
          currentTime: Math.floor(180 + END_OF_TRACK_GRACE_S) - 20,
          serverTimestamp: NOW - 20_000,
        }),
      ),
    ).toBe(false)
  })
})
