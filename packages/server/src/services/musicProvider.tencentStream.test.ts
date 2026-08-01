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
  return { ...actual, getPlayUrl: vi.fn() }
})

vi.mock('./tencentAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./tencentAuthService.js')>('./tencentAuthService.js')
  return actual
})

import { MusicProvider, tencentFileCandidatesForBitrate } from './musicProvider.js'

function okResponse(data: unknown) {
  return { ok: true, json: async () => data }
}

/** Build a musicu.fcg vkey response whose midurlinfo matches the request order. */
function vkeyResponse(
  entries: Array<{ filename: string; purl?: string; result?: number }>,
  sip: string[] = [],
  key: 'req' | 'req_0' = 'req',
): Record<string, unknown> {
  return {
    code: 0,
    [key]: {
      code: 0,
      data: {
        sip,
        midurlinfo: entries.map((e) => ({ songmid: 'MID1', ...e })),
      },
    },
  }
}

/** 320kbps 下四个档位全部 104003（无权限）。 */
function allDenied(mediaMid = 'MID1') {
  return vkeyResponse([
    { filename: `M800${mediaMid}.mp3`, result: 104003 },
    { filename: `C600${mediaMid}.m4a`, result: 104003 },
    { filename: `M500${mediaMid}.mp3`, result: 104003 },
    { filename: `C400${mediaMid}.m4a`, result: 104003 },
  ])
}

/** 320kbps 下四个档位全部 104004（vkey 获取失败）。 */
function allEmpty(mediaMid = 'MID1') {
  return vkeyResponse([
    { filename: `M800${mediaMid}.mp3`, result: 104004 },
    { filename: `C600${mediaMid}.m4a`, result: 104004 },
    { filename: `M500${mediaMid}.mp3`, result: 104004 },
    { filename: `C400${mediaMid}.m4a`, result: 104004 },
  ])
}

function searchSong(mid: string, mediaMid: string, extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    mid,
    name: '测试歌',
    title: '测试歌',
    interval: 180,
    singer: [{ id: 1, mid: 'singer-1', name: '歌手' }],
    album: { id: 1, mid: 'album-1', name: '专辑', title: '专辑', pmid: 'album-pmid' },
    file: { media_mid: mediaMid },
    pay: { pay_play: 0, pay_month: 0, pay_down: 0, price_track: 0 },
    action: { msgpay: 0 },
    ...extra,
  }
}

describe('tencentFileCandidatesForBitrate', () => {
  it('maps room qualities to QQ file candidates (high → low)', () => {
    expect(tencentFileCandidatesForBitrate(999).map((c) => c.code)).toEqual(['F000', 'M800', 'C600', 'M500'])
    expect(tencentFileCandidatesForBitrate(320).map((c) => c.code)).toEqual(['M800', 'C600', 'M500', 'C400'])
    expect(tencentFileCandidatesForBitrate(192).map((c) => c.code)).toEqual(['C600', 'M500', 'C400'])
    expect(tencentFileCandidatesForBitrate(128).map((c) => c.code)).toEqual(['M500', 'C400', 'C200'])
  })
})

describe('MusicProvider tencent stream resolution', () => {
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

  it('resolves a free song anonymously via the plain vkey endpoint (fallback CDN)', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        vkeyResponse([
          { filename: 'M800MID1.mp3', result: 104003 },
          { filename: 'C600MID1.m4a', result: 104003 },
          { filename: 'M500MID1.mp3', result: 0, purl: 'M500MID1.mp3?guid=1&vkey=ABC&uin=&fromtag=106042' },
          { filename: 'C400MID1.m4a', result: 104003 },
        ]),
      ),
    )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBe('https://isure.stream.qqmusic.qq.com/M500MID1.mp3?guid=1&vkey=ABC&uin=&fromtag=106042')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    const body = JSON.parse(init.body)
    expect(body.req.module).toBe('music.vkey.GetVkey')
    expect(body.req.method).toBe('UrlGetVkey')
    expect(body.req.param.filename).toEqual(['M800MID1.mp3', 'C600MID1.m4a', 'M500MID1.mp3', 'C400MID1.m4a'])
    expect(body.req.param.uin).toBe('0')
    expect(init.headers.Cookie).toBeUndefined()
  })

  it('uses the room cookie uin and forwards it with the request', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        vkeyResponse(
          [{ filename: 'M800MID1.mp3', result: 0, purl: 'M800MID1.mp3?guid=9&vkey=XYZ' }],
          ['https://ws.stream.qqmusic.qq.com/'],
        ),
      ),
    )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320, 'uin=123456; qm_keyst=abc; qqmusic_key=abc')

    expect(result.url).toBe('https://ws.stream.qqmusic.qq.com/M800MID1.mp3?guid=9&vkey=XYZ')
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    const body = JSON.parse(init.body)
    expect(body.req.param.uin).toBe('123456')
    expect(init.headers.Cookie).toContain('uin=123456')
  })

  it('falls back to the signed musics.fcg channel when plain musicu.fcg is IP-blocked', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ code: 500001 }))
      .mockResolvedValueOnce(
        okResponse(vkeyResponse([{ filename: 'M800MID1.mp3', result: 0, purl: 'M800MID1.mp3?guid=2&vkey=SIGNED' }])),
      )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBe('https://isure.stream.qqmusic.qq.com/M800MID1.mp3?guid=2&vkey=SIGNED')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [secondUrl] = fetchMock.mock.calls[1] as [string]
    expect(secondUrl).toContain('musics.fcg?sign=zzc')
  })

  it('falls back to the legacy vkey channel when plain and signed are blocked', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ code: 500001 }))
      .mockResolvedValueOnce(okResponse({ code: 500001 }))
      .mockResolvedValueOnce(
        okResponse(
          vkeyResponse(
            [{ filename: 'M500MID1.mp3', result: 0, purl: 'M500MID1.mp3?guid=3&vkey=LEGACY' }],
            [],
            'req_0',
          ),
        ),
      )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBe('https://isure.stream.qqmusic.qq.com/M500MID1.mp3?guid=3&vkey=LEGACY')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [thirdUrl, thirdInit] = fetchMock.mock.calls[2] as [string, { method: string }]
    expect(thirdUrl).toContain('vkey.GetVkeyServer')
    expect(thirdInit.method).toBe('GET')
  })

  it('classifies permission denials as login_required without a cookie', async () => {
    fetchMock.mockResolvedValue(okResponse(allDenied()))

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('login_required')
    // plain + signed + legacy 各一次，权限拒绝不触发 media_mid 恢复
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('classifies permission denials as vip_or_copyright when a cookie is present', async () => {
    fetchMock.mockResolvedValue(okResponse(allDenied()))

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320, 'uin=123456; qm_keyst=abc')

    expect(result.url).toBeNull()
    expect(result.reason).toBe('vip_or_copyright')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('recovers the real media_mid from track info and retries once', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(allEmpty()))
      .mockResolvedValueOnce(okResponse(allEmpty()))
      .mockResolvedValueOnce(okResponse(allEmpty()))
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          'music.trackInfo.UniformRuleCtrl': {
            code: 0,
            data: { tracks: [{ mid: 'MID1', file: { media_mid: 'REALMEDIA' } }] },
          },
        }),
      )
      .mockResolvedValueOnce(
        okResponse(vkeyResponse([{ filename: 'M800REALMEDIA.mp3', result: 0, purl: 'M800REALMEDIA.mp3?guid=2&vkey=RETRY' }])),
      )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBe('https://isure.stream.qqmusic.qq.com/M800REALMEDIA.mp3?guid=2&vkey=RETRY')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('recovers media_mid via the legacy song endpoint when track info is IP-blocked', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(allEmpty()))
      .mockResolvedValueOnce(okResponse(allEmpty()))
      .mockResolvedValueOnce(okResponse(allEmpty()))
      // plain track info: IP blocked
      .mockResolvedValueOnce(okResponse({ code: 500001 }))
      // signed track info: empty
      .mockResolvedValueOnce(okResponse({ code: 0, req: { code: 0, data: { tracks: [] } } }))
      // legacy fcg_play_single_song: works
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          data: [
            {
              mid: 'MID1',
              name: '测试歌',
              singer: [{ id: 1, mid: 's1', name: '歌手' }],
              album: { id: 1, mid: 'a1', name: '专辑', title: '专辑' },
              file: { media_mid: 'LEGACYMEDIA' },
              pay: {},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse(vkeyResponse([{ filename: 'M500LEGACYMEDIA.mp3', result: 0, purl: 'M500LEGACYMEDIA.mp3?guid=4&vkey=LEGACYMEDIA' }])),
      )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBe('https://isure.stream.qqmusic.qq.com/M500LEGACYMEDIA.mp3?guid=4&vkey=LEGACYMEDIA')
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('caches anonymous stream URLs', async () => {
    fetchMock.mockResolvedValue(
      okResponse(vkeyResponse([{ filename: 'M500MID1.mp3', result: 0, purl: 'M500MID1.mp3?guid=7&vkey=CACHE' }])),
    )

    await provider.getStreamUrlResult('tencent', 'MID1', 128)
    await provider.getStreamUrlResult('tencent', 'MID1', 128)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns upstream_failed when all channels reject', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 128)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('upstream_failed')
    // vkey 三通道全失败后还会尝试 media_mid 恢复（同样三通道），共 6 次
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})

describe('MusicProvider tencent search fallback', () => {
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

  it('uses the desktop API when it returns results', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        code: 0,
        'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
          code: 0,
          data: { body: { song: { list: [searchSong('MID1', 'MED1')] } } },
        },
      }),
    )

    const tracks = await provider.search('tencent', '测试', 1, 1)

    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ sourceId: 'MID1', urlId: 'MID1', mediaMid: 'MED1', title: '测试歌' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the signed musics.fcg when the desktop API is blocked', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          'music.search.SearchCgiService.DoSearchForQQMusicDesktop': { code: 2001 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          req: { code: 0, data: { body: { song: { list: [searchSong('MID2', 'MED2')] } } } },
        }),
      )

    const tracks = await provider.search('tencent', '测试', 1, 1)

    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ sourceId: 'MID2', mediaMid: 'MED2' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [secondUrl] = fetchMock.mock.calls[1] as [string]
    expect(secondUrl).toContain('musics.fcg?sign=zzc')
  })

  it('falls back to the legacy client_search_cp when desktop and signed return empty', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
            code: 0,
            data: { body: { song: { list: [] } } },
          },
        }),
      )
      .mockResolvedValueOnce(okResponse({ code: 0, req: { code: 0, data: { body: { song: { list: [] } } } } }))
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          data: {
            song: {
              list: [
                searchSong('MID3', 'MED3', {
                  pay: { pay_play: 1, pay_month: 0, pay_down: 0, price_track: 200 },
                }),
              ],
            },
          },
        }),
      )

    const tracks = await provider.search('tencent', '测试', 1, 1)

    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ sourceId: 'MID3', mediaMid: 'MED3', vip: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [thirdUrl] = fetchMock.mock.calls[2] as [string]
    expect(thirdUrl).toContain('client_search_cp')
  })
})
