import { beforeEach, describe, expect, it, vi } from 'vitest'

const ncmApiMock = vi.hoisted(() => ({
  album: vi.fn(),
  playlist_track_all: vi.fn(),
  song_detail: vi.fn(),
  song_url_v1: vi.fn(),
  register_anonimous: vi.fn(),
}))

vi.mock('@neteasecloudmusicapienhanced/api', () => ({ default: ncmApiMock }))

vi.mock('./neteaseApiBootstrap.js', () => ({
  ensureNeteaseApiReady: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./kugouShortCodeService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouShortCodeService.js')>('./kugouShortCodeService.js')
  return { ...actual, resolveKugouShortCode: vi.fn() }
})

vi.mock('./kugouAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouAuthService.js')>('./kugouAuthService.js')
  return { ...actual, getPlayUrl: vi.fn() }
})

vi.mock('./tencentAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./tencentAuthService.js')>('./tencentAuthService.js')
  return actual
})

import { MusicProvider, neteaseLevelsForBitrate } from './musicProvider.js'

describe('neteaseLevelsForBitrate', () => {
  it('maps room qualities to descending song_url_v1 levels', () => {
    expect(neteaseLevelsForBitrate(999)).toEqual(['lossless', 'exhigh', 'standard'])
    expect(neteaseLevelsForBitrate(320)).toEqual(['exhigh', 'standard'])
    expect(neteaseLevelsForBitrate(192)).toEqual(['exhigh', 'standard'])
    expect(neteaseLevelsForBitrate(128)).toEqual(['standard'])
  })
})

describe('MusicProvider netease stream resolution', () => {
  let provider: MusicProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new MusicProvider()
  })

  it('uses room cookie with song_url_v1 and skips anonymous registration', async () => {
    ncmApiMock.song_url_v1.mockResolvedValue({
      body: {
        code: 200,
        data: [{ url: 'http://m7.music.126.net/song.mp3', fee: 0, code: 200 }],
      },
    })

    const result = await provider.getStreamUrlResult('netease', '1594413', 320, 'MUSIC_U=room-cookie')

    expect(result.url).toBe('https://m7.music.126.net/song.mp3')
    expect(result.usedAnonymousCookie).toBeFalsy()
    expect(ncmApiMock.register_anonimous).not.toHaveBeenCalled()
    expect(ncmApiMock.song_url_v1).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1594413',
        level: 'exhigh',
        cookie: 'MUSIC_U=room-cookie',
      }),
    )
  })

  it('falls back to anonymous cookie when no room cookie is provided', async () => {
    ncmApiMock.register_anonimous.mockResolvedValue({
      body: { code: 200, cookie: 'MUSIC_A=anon-token' },
      cookie: ['MUSIC_A=anon-token'],
    })
    ncmApiMock.song_url_v1.mockResolvedValue({
      body: {
        code: 200,
        data: [{ url: 'https://m7.music.126.net/free.mp3', fee: 8, code: 200 }],
      },
    })

    const result = await provider.getStreamUrlResult('netease', '2005125394', 320)

    expect(result.url).toContain('free.mp3')
    expect(result.usedAnonymousCookie).toBe(true)
    expect(ncmApiMock.register_anonimous).toHaveBeenCalledTimes(1)
    expect(ncmApiMock.song_url_v1).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: 'MUSIC_A=anon-token',
        level: 'exhigh',
      }),
    )
  })

  it('degrades quality levels when higher tiers return empty urls', async () => {
    ncmApiMock.song_url_v1
      .mockResolvedValueOnce({
        body: { code: 200, data: [{ url: null, fee: 0, code: 200 }] },
      })
      .mockResolvedValueOnce({
        body: { code: 200, data: [{ url: 'https://m7.music.126.net/standard.mp3', fee: 0, code: 200 }] },
      })

    const result = await provider.getStreamUrlResult('netease', '1594413', 320, 'MUSIC_U=x')

    expect(result.url).toBe('https://m7.music.126.net/standard.mp3')
    expect(result.level).toBe('standard')
    expect(ncmApiMock.song_url_v1).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ level: 'exhigh' }),
    )
    expect(ncmApiMock.song_url_v1).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ level: 'standard' }),
    )
  })

  it('classifies vip/copyright failures without a usable stream url', async () => {
    ncmApiMock.song_url_v1.mockResolvedValue({
      body: {
        code: 200,
        data: [{ url: null, fee: 1, code: 200, freeTrialInfo: { start: 0, end: 30 } }],
      },
    })

    const result = await provider.getStreamUrlResult('netease', '347230', 320)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('login_required')
    expect(result.detail).toMatch(/登录/)
  })

  it('classifies vip_or_copyright when a logged-in cookie still cannot unlock the track', async () => {
    ncmApiMock.song_url_v1.mockResolvedValue({
      body: {
        code: 200,
        data: [{ url: null, fee: 1, code: -110 }],
      },
    })

    const result = await provider.getStreamUrlResult('netease', '347230', 320, 'MUSIC_U=vip')

    expect(result.url).toBeNull()
    expect(result.reason).toBe('vip_or_copyright')
  })
})
