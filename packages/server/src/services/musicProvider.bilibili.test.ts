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

/** bilibili 正常 JSON 响应（带 content-type，走新的 res.ok + content-type 判定）。 */
function okResponse(data: unknown, contentType = 'application/json; charset=utf-8') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => data,
  }
}

/** bilibili 反爬：海外 IP 下 view 接口返回 412 + HTML 验证码页，json() 必抛。 */
function blockedResponse(status = 412) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    json: async () => {
      throw new SyntaxError("Unexpected token '<'")
    },
  }
}

const PAGELIST_DATA = { code: 0, data: [{ cid: 123456, page: 1, part: '正片' }] }

/** 按 URL 子串路由 fetch mock，未命中返回 412（模拟被反爬挡掉的接口）。 */
function routedFetch(routes: Array<[string, () => unknown]>): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    for (const [needle, respond] of routes) {
      if (url.includes(needle)) return respond()
    }
    return blockedResponse()
  })
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

  it('resolves av/bvid IDs through the view API when it is available', async () => {
    fetchMock.mockImplementation(
      routedFetch([
        ['x/player/pagelist', () => okResponse(PAGELIST_DATA)],
        [
          'x/web-interface/view',
          () =>
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
        ],
      ]),
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

    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls.some((url) => url.includes('x/player/pagelist?aid=170001'))).toBe(true)
    expect(urls.some((url) => url.includes('x/web-interface/view?aid=170001'))).toBe(true)
  })

  // 核心回归测试：香港等海外 IP 下 view 返回 412 HTML，旧实现会抛
  // `Unexpected token '<'` → 无法获取 cid → B站完全不可播。cid 必须改由 pagelist 拿到。
  it('仍然能在 view 返回 412 HTML 时通过 pagelist 拿到 cid 并解析出播放链接', async () => {
    fetchMock.mockImplementation(
      routedFetch([
        ['x/player/pagelist', () => okResponse(PAGELIST_DATA)],
        ['x/web-interface/view', () => blockedResponse(412)],
        [
          'x/player/playurl',
          () =>
            okResponse({
              code: 0,
              data: {
                dash: {
                  audio: [
                    {
                      baseUrl: 'https://upos-sz-mirrorcosov.bilivideo.com/a.m4s',
                      backupUrl: ['https://upos-sz-mirror08.bilivideo.com/a.m4s'],
                      bandwidth: 320000,
                    },
                  ],
                },
              },
            }),
        ],
      ]),
    )

    const track = await provider.getTrackById('bilibili', 'BV1xx411c7mD')
    expect(track).not.toBeNull()
    expect(track?.bilibiliCid).toBe(123456)
    // view 不可用 → 元数据降级，但 sourceId 仍来自入参，播放不受影响
    expect(track?.sourceId).toBe('BV1xx411c7mD')

    const result = await provider.getStreamUrlResult('bilibili', 'BV1xx411c7mD', 320)
    expect(result.url).toBe('https://upos-sz-mirrorcosov.bilivideo.com/a.m4s')
    expect(result.backupUrl).toBe('https://upos-sz-mirror08.bilivideo.com/a.m4s')

    const playCall = fetchMock.mock.calls.find((call) => (call[0] as string).includes('x/player/playurl'))
    expect(playCall).toBeDefined()
    expect(playCall?.[0]).toContain('cid=123456')
  })

  it('view 返回非 JSON 时降级为元数据缺失，不抛异常', async () => {
    fetchMock.mockImplementation(
      routedFetch([
        ['x/player/pagelist', () => okResponse(PAGELIST_DATA)],
        ['x/web-interface/view', () => blockedResponse(412)],
      ]),
    )

    // 关键：整个调用不得 reject（旧实现会抛 Unexpected token '<'）
    const resolved = await provider.getTrackById('bilibili', 'av170002')
    expect(resolved).not.toBeNull()
    // view 不可用 → 入参兜底，av 号归一化为 avN；标题/封面缺失但仍可播放
    expect(resolved?.sourceId).toBe('av170002')
    expect(resolved?.urlId).toBe('av170002')
    expect(resolved?.bilibiliCid).toBe(123456)
    expect(resolved?.title).toBe('Unknown')
  })

  it('playurl 直连（注册表无 cid）时用 pagelist 兜底解析播放链接', async () => {
    fetchMock.mockImplementation(
      routedFetch([
        ['x/player/pagelist', () => okResponse(PAGELIST_DATA)],
        [
          'x/player/playurl',
          () =>
            okResponse({
              code: 0,
              data: {
                dash: {
                  audio: [{ baseUrl: 'https://upos-sz-mirrorcosov.bilivideo.com/cold.m4s', bandwidth: 320000 }],
                },
              },
            }),
        ],
      ]),
    )

    const result = await provider.getStreamUrlResult('bilibili', 'BV1xx411c7mD', 320)

    expect(result.url).toBe('https://upos-sz-mirrorcosov.bilivideo.com/cold.m4s')
    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls.some((url) => url.includes('x/player/pagelist?bvid=BV1xx411c7mD'))).toBe(true)
    expect(urls.some((url) => url.includes('x/player/playurl') && url.includes('cid=123456'))).toBe(true)
  })

  it('returns a DASH audio URL plus backup URL from playurl', async () => {
    // Resolve the track first so the cid is registered in the track registry.
    fetchMock.mockImplementation(
      routedFetch([
        ['x/player/pagelist', () => okResponse(PAGELIST_DATA)],
        [
          'x/web-interface/view',
          () =>
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
        ],
        [
          'x/player/playurl',
          () =>
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
        ],
      ]),
    )

    await provider.getTrackById('bilibili', 'BV1xx411c7mD')

    const result = await provider.getStreamUrlResult('bilibili', 'BV1xx411c7mD', 320)

    expect(result.url).toBe('https://xyjs0.bilivideo.com/high.m4s')
    expect(result.backupUrl).toBe('https://upos-sz-mirror08.bilivideo.com/high.m4s')

    const playCall = fetchMock.mock.calls.find((call) => (call[0] as string).includes('x/player/playurl')) as [string]
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
