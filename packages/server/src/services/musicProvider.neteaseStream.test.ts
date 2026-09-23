import { beforeEach, describe, expect, it, vi } from 'vitest'

const ncmApiMock = vi.hoisted(() => ({
  album: vi.fn(),
  playlist_track_all: vi.fn(),
  song_detail: vi.fn(),
  song_url_v1: vi.fn(),
  song_url_match: vi.fn(),
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

import {
  MusicProvider,
  NETEASE_REAL_IP_FALLBACK,
  NETEASE_TOTAL_BUDGET_MS,
  neteaseLevelsForBitrate,
} from './musicProvider.js'

/** 香港式失败：不带 realIP 时上游按 IP 直接拒（entry.code=404），带大陆 realIP 时给 url。 */
function hkLikeServer() {
  ncmApiMock.song_url_v1.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.realIP) {
      return {
        body: {
          code: 200,
          data: [{ url: 'https://m801.music.126.net/hk-recovered.mp3', fee: 0, code: 200 }],
        },
      }
    }
    return { body: { code: 200, data: [{ url: null, fee: 0, code: 404 }] } }
  })
}

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
    ncmApiMock.song_url_match.mockResolvedValue({ body: { code: 200, data: null } })

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
    ncmApiMock.song_url_match.mockResolvedValue({ body: { code: 200, data: null } })

    const result = await provider.getStreamUrlResult('netease', '347230', 320, 'MUSIC_U=vip')

    expect(result.url).toBeNull()
    expect(result.reason).toBe('vip_or_copyright')
  })

  it('falls back to song_url_match when plain song_url_v1 returns empty/404', async () => {
    ncmApiMock.song_url_v1.mockResolvedValue({
      body: {
        code: 200,
        data: [{ url: null, fee: 0, code: 404 }],
      },
    })
    ncmApiMock.song_url_match.mockResolvedValue({
      body: {
        code: 200,
        data: 'https://m801.music.126.net/matched.flac',
      },
    })

    const result = await provider.getStreamUrlResult('netease', '2005125394', 320)

    expect(result.url).toBe('https://m801.music.126.net/matched.flac')
    expect(result.level).toBe('match')
    expect(ncmApiMock.song_url_match).toHaveBeenCalled()
  })
})

/**
 * 香港生产实测（2026-09，独立进程对照，开固定探针抓真实出站请求头）：
 * - 纯 baseline（无任何 IP 参数）：10 首样本只 1 首成功，其余 entry.code=404；
 * - 仅加 realIP='<大陆 IP>'：同内核同 cookie 10/10 成功，每首 ≈200-350ms，
 *   出站请求头确实带 X-Real-IP / X-Forwarded-For，返回 url 在香港 Range 拉流 HTTP 206；
 * - randomCNIP:true 与 ENABLE_RANDOM_CN_IP=true：出站请求**完全没有** X-Real-IP 头，
 *   结果与 baseline 一致（嵌入式调用不消费这两个开关，只有 server.js 路由层才读 global.cnIp）；
 * - 反向对照 realIP='8.8.8.8' / realIP=<香港本机出口>：头正确发出但依然 404，
 *   证明起作用的是「大陆 IP 身份」而不是「多带了一个头」。
 */
describe('MusicProvider netease Hong Kong IP recovery', () => {
  let provider: MusicProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new MusicProvider()
    ncmApiMock.register_anonimous.mockResolvedValue({
      body: { code: 200, cookie: 'MUSIC_A=anon' },
      cookie: ['MUSIC_A=anon'],
    })
    ncmApiMock.song_url_match.mockResolvedValue({ body: { code: 200, data: null } })
  })

  it('recovers a playable url on Hong Kong-style 404 by declaring a China-mainland realIP', async () => {
    hkLikeServer()

    const result = await provider.getStreamUrlResult('netease', '2005125394', 320)

    expect(result.url).toBe('https://m801.music.126.net/hk-recovered.mp3')
    // 恢复请求必须携带 realIP —— 这是香港可播的唯一机制。
    expect(ncmApiMock.song_url_v1).toHaveBeenCalledWith(
      expect.objectContaining({ id: '2005125394', realIP: NETEASE_REAL_IP_FALLBACK }),
    )
  })

  it('falls back to the plain (no-IP) request when the declared realIP itself is refused', async () => {
    // realIP 通道先跑；若该 IP 被判拒（例如大陆直连本就正常），仍能退回原路径并保留原 level 语义。
    ncmApiMock.song_url_v1.mockImplementation(async (params: Record<string, unknown>) => {
      if (params.realIP) {
        return { body: { code: 200, data: [{ url: null, fee: 0, code: 404 }] } }
      }
      return { body: { code: 200, data: [{ url: 'https://m7.music.126.net/direct.mp3', fee: 0, code: 200 }] } }
    })

    const result = await provider.getStreamUrlResult('netease', '1594413', 320)

    expect(result.url).toBe('https://m7.music.126.net/direct.mp3')
    expect(result.level).toBe('exhigh')
  })

  it('still classifies vip/copyright when even the mainland realIP cannot unlock the track', async () => {
    // 真 VIP 歌：加了大陆 realIP 依然没有 url，分类语义不能被 realIP 通道改变。
    ncmApiMock.song_url_v1.mockImplementation(async () => ({
      body: { code: 200, data: [{ url: null, fee: 1, code: 200, freeTrialInfo: { start: 0, end: 30 } }] },
    }))

    const result = await provider.getStreamUrlResult('netease', '347230', 320)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('login_required')
    expect(result.detail).toMatch(/登录/)
  })

  it('keeps vip_or_copyright semantics with a logged-in cookie under realIP recovery', async () => {
    ncmApiMock.song_url_v1.mockImplementation(async () => ({
      body: { code: 200, data: [{ url: null, fee: 1, code: -110 }] },
    }))

    const result = await provider.getStreamUrlResult('netease', '347230', 320, 'MUSIC_U=vip')

    expect(result.url).toBeNull()
    expect(result.reason).toBe('vip_or_copyright')
  })
})

/**
 * 防卡死回归的核心测试：生产实测单曲 ≈46,500 ms，全部来自无超时的第三方解灰服务
 * （bikonkoo/bysuns/... 自身不设超时，上游挂住时 promise 永不 settle）。
 * 这里用永不 settle 的 mock 构造「上游挂起」，断言总耗时被预算硬性截断。
 */
describe('MusicProvider netease failure-path latency is bounded', () => {
  let provider: MusicProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new MusicProvider()
  })

  it('gives up quickly when every upstream call hangs (no 46s stall)', async () => {
    // 每条通道都挂起：匿名 cookie、无 IP song_url_v1、realIP song_url_v1、解灰通道。
    ncmApiMock.register_anonimous.mockImplementation(() => new Promise(() => {}))
    ncmApiMock.song_url_v1.mockImplementation(() => new Promise(() => {}))
    ncmApiMock.song_url_match.mockImplementation(() => new Promise(() => {}))

    const started = Date.now()
    const result = await provider.getStreamUrlResult('netease', '2005125394', 320)
    const elapsed = Date.now() - started

    expect(result.url).toBeNull()
    // 硬性上界：单曲总预算 + 一点调度余量。改前实测 46,500ms。
    expect(elapsed).toBeLessThan(NETEASE_TOTAL_BUDGET_MS + 1_500)
    // 而且必须给出可操作的分类，不是笼统失败。
    expect(result.reason).toBe('timeout')
  }, 20_000)

  it('caps the unblock path even when only the third-party unblock service hangs', async () => {
    // song_url_v1 的普通通道立刻返回 404（香港式），只有解灰通道挂住 —— 正是生产现场。
    ncmApiMock.register_anonimous.mockResolvedValue({
      body: { code: 200, cookie: 'MUSIC_A=anon' },
      cookie: ['MUSIC_A=anon'],
    })
    ncmApiMock.song_url_v1.mockImplementation(async (params: Record<string, unknown>) => {
      if (params.unblock === 'true') return new Promise(() => {}) as never
      return { body: { code: 200, data: [{ url: null, fee: 0, code: 404 }] } }
    })
    ncmApiMock.song_url_match.mockImplementation(() => new Promise(() => {}))

    const started = Date.now()
    const result = await provider.getStreamUrlResult('netease', '2005125394', 320)
    const elapsed = Date.now() - started

    expect(result.url).toBeNull()
    expect(elapsed).toBeLessThan(NETEASE_TOTAL_BUDGET_MS + 1_500)
    // 上游明确给了 404（不是超时），所以分类应保持 login_required 语义。
    expect(result.reason).toBe('login_required')
  }, 20_000)

  it('reports timeout when the primary upstream never answers at all', async () => {
    ncmApiMock.register_anonimous.mockResolvedValue(null)
    ncmApiMock.song_url_v1.mockImplementation(() => new Promise(() => {}))
    ncmApiMock.song_url_match.mockImplementation(() => new Promise(() => {}))

    const result = await provider.getStreamUrlResult('netease', '2005125394', 320)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('timeout')
    expect(result.detail).toMatch(/超时/)
  }, 20_000)
})
