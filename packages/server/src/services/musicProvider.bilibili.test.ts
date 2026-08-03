import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@neteasecloudmusicapienhanced/api', () => ({ default: {} }))

vi.mock('./neteaseApiBootstrap.js', () => ({
  ensureNeteaseApiReady: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./kugouShortCodeService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouShortCodeService.js')>('./kugouShortCodeService.js')
  return { ...actual, resolveKugouShortCode: vi.fn() }
})

vi.mock('./kugouAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouAuthService.js')>('./kugouAuthService.js')
  return { ...actual, getPlayUrl: vi.fn(), getCover: vi.fn() }
})

vi.mock('./tencentAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./tencentAuthService.js')>('./tencentAuthService.js')
  return actual
})

import { MusicProvider } from './musicProvider.js'

function okResponse(data: unknown) {
  return { ok: true, json: async () => data }
}

describe('MusicProvider bilibili source', () => {
  let provider: MusicProvider
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    provider = new MusicProvider()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('searches videos using the fingerprint cookie and maps results to tracks', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ data: { b_3: 'B3', b_4: 'B4' } })).mockResolvedValueOnce(
      okResponse({
        code: 0,
        data: {
          result: [
            {
              bvid: 'BV1xx411c7mD',
              aid: 170001,
              cid: 123456,
              title: '<em class="keyword">测试</em>视频 &amp; 更多',
              author: '测试UP主',
              pic: '//i0.hdslb.com/bfs/archive/cover.jpg',
              duration: '3:45',
            },
          ],
        },
      }),
    )

    const tracks = await provider.search('bilibili', '测试', 20, 1)

    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({
      source: 'bilibili',
      sourceId: 'BV1xx411c7mD',
      urlId: 'BV1xx411c7mD',
      title: '测试视频 & 更多',
      artist: ['测试UP主'],
      duration: 225,
      cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
      bilibiliCid: 123456,
    })

    const spiCall = fetchMock.mock.calls[0] as [string]
    expect(spiCall[0]).toContain('x/frontend/finger/spi')

    const searchCall = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }]
    expect(searchCall[0]).toContain('x/web-interface/search/type')
    expect(searchCall[0]).toContain('search_type=video')
    expect(searchCall[1].headers.Cookie).toBe('buvid3=B3;buvid4=B4')
    expect(searchCall[1].headers.Origin).toBe('https://search.bilibili.com')
  })

  it('resolves av/bvid IDs through the view API', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        code: 0,
        data: {
          bvid: 'BV1xx411c7mD',
          aid: 170001,
          cid: 123456,
          title: 'View Title',
          pic: 'http://i0.hdslb.com/bfs/archive/view.jpg',
          duration: 300,
          owner: { name: '测试UP主' },
        },
      }),
    )

    const track = await provider.getTrackById('bilibili', 'av170001')

    expect(track).toMatchObject({
      source: 'bilibili',
      sourceId: 'BV1xx411c7mD',
      urlId: 'BV1xx411c7mD',
      title: 'View Title',
      artist: ['测试UP主'],
      duration: 300,
      cover: 'https://i0.hdslb.com/bfs/archive/view.jpg',
      bilibiliCid: 123456,
    })

    const viewCall = fetchMock.mock.calls[0] as [string]
    expect(viewCall[0]).toContain('x/web-interface/view?aid=170001')
  })

  it('returns a DASH audio URL plus backup URL from playurl', async () => {
    // Resolve the track first so the cid is registered in the track registry.
    fetchMock.mockResolvedValueOnce(
      okResponse({
        code: 0,
        data: {
          bvid: 'BV1xx411c7mD',
          aid: 170001,
          cid: 123456,
          title: 'View Title',
          pic: '',
          duration: 300,
          owner: { name: 'UP' },
        },
      }),
    )
    await provider.getTrackById('bilibili', 'BV1xx411c7mD')

    fetchMock.mockResolvedValueOnce(
      okResponse({
        code: 0,
        data: {
          dash: {
            audio: [
              {
                baseUrl: 'https://xyjs0.bilivideo.com/low.m4s',
                backupUrl: ['https://upos-sz-mirror08.bilivideo.com/low.m4s'],
                bandwidth: 132000,
              },
              {
                baseUrl: 'https://xyjs0.bilivideo.com/high.m4s',
                backupUrl: ['https://upos-sz-mirror08.bilivideo.com/high.m4s'],
                bandwidth: 320000,
              },
            ],
          },
        },
      }),
    )

    const result = await provider.getStreamUrlResult('bilibili', 'BV1xx411c7mD', 320)

    expect(result.url).toBe('https://xyjs0.bilivideo.com/high.m4s')
    expect(result.backupUrl).toBe('https://upos-sz-mirror08.bilivideo.com/high.m4s')

    const playCall = fetchMock.mock.calls[1] as [string]
    expect(playCall[0]).toContain('x/player/playurl')
    expect(playCall[0]).toContain('cid=123456')
    expect(playCall[0]).toContain('fnval=16')
    expect(playCall[0]).toContain('bvid=BV1xx411c7mD')
  })

  it('keeps lyric and cover lookups empty for bilibili', async () => {
    await expect(provider.getLyric('bilibili', 'BV1xx411c7mD')).resolves.toEqual({
      lyric: '',
      tlyric: '',
      romalrc: '',
      yrc: '',
    })
    await expect(provider.getCover('bilibili', 'BV1xx411c7mD')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
