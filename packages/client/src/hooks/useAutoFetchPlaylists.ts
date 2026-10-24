import { useEffect, useRef } from 'react'

interface AutoFetchPlaylistsOptions {
  /** 是否已登录（未登录时清空「本次登录已拉取」标记） */
  enabled: boolean
  /** 登录身份标识：同一账号重复渲染视为同一次登录，换账号/重新登录才算新的一次 */
  loginKey: string
  /** 是否正在加载 */
  loading: boolean
  /** 拉取动作；允许每次渲染都是新的函数引用 */
  fetch: () => void
}

/**
 * 每次登录只自动拉取一次歌单。
 *
 * 旧实现用 `playlists.length === 0 && !loading` 作为触发条件，副作用是：
 * 服务端返回空列表时 length 永远为 0，而 loading 会 true→false→true 抖动，
 * 于是 effect 在每次渲染都重新发起一次请求（生产环境实测 8 分钟内 417 次
 * `QQ getUserPlaylists: missing uin in cookie`），并把整个页面拖进无限重渲染。
 *
 * 现在用「本次登录已拉取」标记做一次性判定：空列表不再触发重试，
 * 用户仍可用界面上的「刷新」按钮手动重拉。
 */
export function useAutoFetchPlaylists({ enabled, loginKey, loading, fetch }: AutoFetchPlaylistsOptions): void {
  const fetchedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      fetchedKeyRef.current = null
      return
    }
    if (fetchedKeyRef.current === loginKey) return
    if (loading) return

    fetchedKeyRef.current = loginKey
    fetch()
  }, [enabled, loginKey, loading, fetch])
}
