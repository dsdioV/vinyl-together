// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQrStatusPolling } from './useQrStatusPolling'

interface Options {
  active: boolean
  key: string | null
  intervalMs: number
  onPoll: (key: string) => void
}

describe('useQrStatusPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls on a fixed cadence', () => {
    const onPoll = vi.fn()
    renderHook(() => useQrStatusPolling({ active: true, key: 'qr-key', intervalMs: 2000, onPoll }))

    expect(onPoll).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(onPoll).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(onPoll).toHaveBeenCalledTimes(4)
    expect(onPoll).toHaveBeenLastCalledWith('qr-key')
  })

  // 回归测试：扫码授权后网站没有任何反应。
  // 父组件（PlatformHub）把内联箭头函数传给 onCheckStatus，每次渲染都是新引用。
  // 修复前 onPoll 位于 effect 依赖数组中，父组件每次重渲染都会重建定时器，
  // 只要重渲染比轮询间隔更频繁，定时器就永远不会触发。
  it('keeps polling when the parent re-renders faster than the interval', () => {
    const calls: string[] = []
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useQrStatusPolling({
          active: true,
          key: 'qr-key',
          intervalMs: 2000,
          // 每次渲染都是新的函数引用，模拟 PlatformHub 的内联箭头函数
          onPoll: (key) => {
            calls.push(`${key}@${tick}`)
          },
        }),
      { initialProps: { tick: 0 } },
    )

    // 模拟繁忙房间：每 100ms 重渲染一次，远快于 2s 的轮询间隔
    for (let tick = 1; tick <= 30; tick++) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      rerender({ tick })
    }

    // 3 秒过去，2s 轮询至少应触发一次；修复前这里是 0 次
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].startsWith('qr-key@')).toBe(true)
  })

  it('always invokes the latest callback without restarting the timer', () => {
    const seen: string[] = []
    const { rerender } = renderHook(
      ({ label }: { label: string }) =>
        useQrStatusPolling({
          active: true,
          key: 'qr-key',
          intervalMs: 1000,
          onPoll: () => seen.push(label),
        }),
      { initialProps: { label: 'first' } },
    )

    act(() => {
      vi.advanceTimersByTime(500)
    })
    rerender({ label: 'second' })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    // 定时器没有被重建，因此按原节奏在 1000ms 触发一次，且用的是最新回调
    expect(seen).toEqual(['second'])
  })

  it('does not poll while inactive or without a key', () => {
    const onPoll = vi.fn()
    const { rerender } = renderHook(
      (props: Options) => useQrStatusPolling(props),
      { initialProps: { active: false, key: 'qr-key', intervalMs: 1000, onPoll } },
    )
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onPoll).not.toHaveBeenCalled()

    rerender({ active: true, key: null, intervalMs: 1000, onPoll })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onPoll).not.toHaveBeenCalled()

    rerender({ active: true, key: 'qr-key', intervalMs: 1000, onPoll })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onPoll).toHaveBeenCalledTimes(1)
  })

  it('stops polling on unmount', () => {
    const onPoll = vi.fn()
    const { unmount } = renderHook(() =>
      useQrStatusPolling({ active: true, key: 'qr-key', intervalMs: 1000, onPoll }),
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onPoll).toHaveBeenCalledTimes(1)

    unmount()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onPoll).toHaveBeenCalledTimes(1)
  })
})
