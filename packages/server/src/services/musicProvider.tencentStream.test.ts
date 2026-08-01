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

import { MusicProvider, tencentFileCandidatesForBitrate } from './musicProvider.js'

function okResponse(data: unknown) {
  return { ok: true, json: async () => data }
}

/** Build a musicu.fcg vkey response whose midurlinfo matches the request order. */
function vkeyResponse(
  entries: Array<{ filename: string; purl?: string; result?: number }>,
  sip: string[] = [],
): Record<string, unknown> {
  return {
    code: 0,
    req: {
      code: 0,
      data: {
        sip,
        midurlinfo: entries.map((e) => ({ songmid: 'MID1', ...e })),
      },
    },
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

  it('resolves a free song anonymously via the new vkey endpoint (fallback CDN)', async () => {
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
      okResponse(vkeyResponse([{ filename: 'M800MID1.mp3', result: 0, purl: 'M800MID1.mp3?guid=9&vkey=XYZ' }], ['https://ws.stream.qqmusic.qq.com/'])),
    )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320, 'uin=123456; qm_keyst=abc; qqmusic_key=abc')

    expect(result.url).toBe('https://ws.stream.qqmusic.qq.com/M800MID1.mp3?guid=9&vkey=XYZ')
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    const body = JSON.parse(init.body)
    expect(body.req.param.uin).toBe('123456')
    expect(init.headers.Cookie).toContain('uin=123456')
  })

  it('classifies permission denials as login_required without a cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse(
          vkeyResponse([
            { filename: 'M800MID1.mp3', result: 104003 },
            { filename: 'C600MID1.m4a', result: 104003 },
            { filename: 'M500MID1.mp3', result: 104003 },
            { filename: 'C400MID1.m4a', result: 104003 },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          'music.trackInfo.UniformRuleCtrl': {
            code: 0,
            data: { tracks: [{ mid: 'MID1', file: { media_mid: 'MID1' } }] },
          },
        }),
      )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('login_required')
  })

  it('classifies permission denials as vip_or_copyright when a cookie is present', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse(
          vkeyResponse([
            { filename: 'M800MID1.mp3', result: 104003 },
            { filename: 'C600MID1.m4a', result: 104003 },
            { filename: 'M500MID1.mp3', result: 104003 },
            { filename: 'C400MID1.m4a', result: 104003 },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        okResponse({
          code: 0,
          'music.trackInfo.UniformRuleCtrl': {
            code: 0,
            data: { tracks: [{ mid: 'MID1', file: { media_mid: 'MID1' } }] },
          },
        }),
      )

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 320, 'uin=123456; qm_keyst=abc')

    expect(result.url).toBeNull()
    expect(result.reason).toBe('vip_or_copyright')
  })

  it('recovers the real media_mid from track info and retries once', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse(
          vkeyResponse([
            { filename: 'M800MID1.mp3', result: 104004 },
            { filename: 'C600MID1.m4a', result: 104004 },
            { filename: 'M500MID1.mp3', result: 104004 },
            { filename: 'C400MID1.m4a', result: 104004 },
          ]),
        ),
      )
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
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [, secondInit] = fetchMock.mock.calls[1] as [string, { body: string }]
    expect(JSON.parse(secondInit.body)['music.trackInfo.UniformRuleCtrl'].method).toBe('CgiGetTrackInfo')
  })

  it('caches anonymous stream URLs', async () => {
    fetchMock.mockResolvedValue(
      okResponse(vkeyResponse([{ filename: 'M500MID1.mp3', result: 0, purl: 'M500MID1.mp3?guid=7&vkey=CACHE' }])),
    )

    await provider.getStreamUrlResult('tencent', 'MID1', 128)
    await provider.getStreamUrlResult('tencent', 'MID1', 128)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns upstream_failed when the request rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    const result = await provider.getStreamUrlResult('tencent', 'MID1', 128)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('upstream_failed')
  })
})
