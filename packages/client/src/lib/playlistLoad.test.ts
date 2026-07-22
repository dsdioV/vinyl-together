import { describe, expect, it } from 'vitest'
import { getPlaylistLoadError, PLAYLIST_NETWORK_ERROR } from './playlistLoad'

describe('getPlaylistLoadError', () => {
  it('preserves the actionable external-playlist limit error', () => {
    expect(
      getPlaylistLoadError(422, {
        code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
        error: '歌单包含 10001 首歌曲，超过支持上限 10000 首',
      }),
    ).toBe('歌单包含 10001 首歌曲，超过支持上限 10000 首')
  })

  it.each([
    [401, '房间身份已失效，请刷新后重试'],
    [403, '你已不在该房间中，无法加载歌单'],
    [500, '歌单加载失败，请稍后重试'],
    [502, '歌单加载失败，请稍后重试'],
  ])('maps HTTP %i to a safe message', (status, expected) => {
    expect(getPlaylistLoadError(status, { error: 'internal details' })).toBe(expected)
  })

  it('falls back safely when the error body is absent', () => {
    expect(getPlaylistLoadError(422, null)).toBe('歌单加载失败，请稍后重试')
  })

  it('provides a stable network failure message', () => {
    expect(PLAYLIST_NETWORK_ERROR).toBe('无法连接服务器，请稍后重试')
  })
})
