// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MyPlatformAuth, Playlist } from '@music-together/shared'
import { PlaylistSection } from './PlaylistSection'

const LOGGED_IN: MyPlatformAuth = { platform: 'tencent', loggedIn: true, nickname: 'Voidsd', vipType: 1 }

function renderSection(overrides: {
  playlists?: Playlist[]
  loading?: boolean
  onFetchMyPlaylists?: () => void
}) {
  return render(
    <PlaylistSection
      platform="tencent"
      myStatus={LOGGED_IN}
      playlists={overrides.playlists ?? []}
      loading={overrides.loading ?? false}
      // 内联箭头函数 —— 与 PlatformHub 的真实用法一致，每次渲染都是新引用
      onFetchMyPlaylists={overrides.onFetchMyPlaylists ?? (() => {})}
      onSelectPlaylist={() => {}}
    />,
  )
}

describe('PlaylistSection auto fetch', () => {
  // 回归测试：生产环境 8 分钟内 417 次 "QQ getUserPlaylists: missing uin in cookie"。
  // 登录成功但服务端返回空列表时，旧实现在每次渲染都会重新请求一次。
  it('does not spam the server when the account has no playlists', () => {
    const fetch = vi.fn()
    const { rerender } = renderSection({ onFetchMyPlaylists: fetch })
    expect(fetch).toHaveBeenCalledTimes(1)

    // 反复重渲染（父组件因房间事件持续刷新）+ loading 抖动，歌单始终为空
    for (let i = 0; i < 20; i++) {
      rerender(
        <PlaylistSection
          platform="tencent"
          myStatus={LOGGED_IN}
          playlists={[]}
          loading={i % 2 === 0}
          onFetchMyPlaylists={fetch}
          onSelectPlaylist={() => {}}
        />,
      )
    }

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches once per login and again after re-login', () => {
    const fetch = vi.fn()
    const { rerender } = renderSection({ onFetchMyPlaylists: fetch })
    expect(fetch).toHaveBeenCalledTimes(1)

    rerender(
      <PlaylistSection
        platform="tencent"
        myStatus={LOGGED_IN}
        playlists={[{ id: '1', name: '我喜欢的音乐', cover: '', trackCount: 12, source: 'tencent' }]}
        loading={false}
        onFetchMyPlaylists={fetch}
        onSelectPlaylist={() => {}}
      />,
    )
    expect(fetch).toHaveBeenCalledTimes(1)

    rerender(
      <PlaylistSection
        platform="tencent"
        myStatus={{ platform: 'tencent', loggedIn: false }}
        playlists={[]}
        loading={false}
        onFetchMyPlaylists={fetch}
        onSelectPlaylist={() => {}}
      />,
    )
    rerender(
      <PlaylistSection
        platform="tencent"
        myStatus={LOGGED_IN}
        playlists={[]}
        loading={false}
        onFetchMyPlaylists={fetch}
        onSelectPlaylist={() => {}}
      />,
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
