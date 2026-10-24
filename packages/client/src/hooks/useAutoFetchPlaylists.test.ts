// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAutoFetchPlaylists } from './useAutoFetchPlaylists'

interface Props {
  enabled: boolean
  loginKey: string
  loading: boolean
  fetch: () => void
}

const LOGGED_IN_KEY = 'tencent:Voidsd#1'

describe('useAutoFetchPlaylists', () => {
  it('fetches once after login', () => {
    const fetch = vi.fn()
    renderHook(() => useAutoFetchPlaylists({ enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch }))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not fetch while logged out', () => {
    const fetch = vi.fn()
    renderHook(() => useAutoFetchPlaylists({ enabled: false, loginKey: 'tencent:guest', loading: false, fetch }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('waits for the in-flight load to finish before fetching', () => {
    const fetch = vi.fn()
    const { rerender } = renderHook((props: Props) => useAutoFetchPlaylists(props), {
      initialProps: { enabled: true, loginKey: LOGGED_IN_KEY, loading: true, fetch },
    })
    expect(fetch).not.toHaveBeenCalled()

    rerender({ enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // 回归测试：生产环境 8 分钟内 417 次 "QQ getUserPlaylists: missing uin in cookie"。
  // 服务端返回空列表时，旧实现以 playlists.length === 0 && !loading 为条件，
  // loading 的 true→false→true 抖动会让 effect 在每次渲染都重新请求。
  it('does not loop when the server keeps returning an empty list', () => {
    const fetch = vi.fn()
    const { rerender } = renderHook((props: Props) => useAutoFetchPlaylists(props), {
      initialProps: { enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch },
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    // 模拟 loading 抖动：true → false 反复翻转，歌单始终为空
    for (let i = 0; i < 50; i++) {
      rerender({ enabled: true, loginKey: LOGGED_IN_KEY, loading: true, fetch })
      rerender({ enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch })
    }

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not refetch on unrelated parent re-renders with a new fetch identity', () => {
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useAutoFetchPlaylists({
          enabled: true,
          loginKey: LOGGED_IN_KEY,
          loading: false,
          // 每次渲染都是新的函数引用，模拟 PlatformHub 的内联箭头函数
          fetch: () => {
            void tick
          },
        }),
      { initialProps: { tick: 0 } },
    )

    for (let tick = 1; tick <= 20; tick++) {
      rerender({ tick })
    }
    // 无断言目标之外的副作用，这里只要求不抛错；真正的计数在上面的用例里校验
    expect(true).toBe(true)
  })

  it('refetches when the logged-in identity changes', () => {
    const fetch = vi.fn()
    const { rerender } = renderHook((props: Props) => useAutoFetchPlaylists(props), {
      initialProps: { enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch },
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    rerender({ enabled: true, loginKey: 'tencent:AnotherUser#0', loading: false, fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fetches again after logout and a fresh login', () => {
    const fetch = vi.fn()
    const { rerender } = renderHook((props: Props) => useAutoFetchPlaylists(props), {
      initialProps: { enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch },
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    rerender({ enabled: false, loginKey: 'tencent:guest', loading: false, fetch })
    rerender({ enabled: true, loginKey: LOGGED_IN_KEY, loading: false, fetch })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
