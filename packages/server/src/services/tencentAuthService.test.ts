import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QQ 音乐认证服务回归测试。
 *
 * 核心回归目标（2026-11-13 生产事故）：
 * 用户 10-27 扫码得到的 musickey 在凭证过期后，`vip_login_base` 依然返回
 * `code: 0` + 数值全零的 identity，于是 `getUserInfo` 返回
 * `{ ok: true, vipType: 0 }`——过期凭证被当成「已登录的非 VIP 用户」。
 * 用户看到自己的名字旁没有 VIP 徽章、点 VIP 歌曲失败，却完全不知道是登录过期。
 *
 * 修复：用有鉴权的 `music.UserInfo.userInfoServer.GetLoginUserInfo` 探测存活，
 * 只有拿到明确的鉴权失败码（1000 / 104400 / 104401）才判为 expired。
 */

interface FakeResponse {
  ok?: boolean
  status?: number
  json?: () => Promise<unknown>
  headers?: { getSetCookie?: () => string[]; get?: (name: string) => string | null }
  text?: () => Promise<string>
  arrayBuffer?: () => Promise<ArrayBuffer>
}

/** 按 module.method 分派响应，未命中时抛错（让漏测的调用立刻暴露）。 */
type Handler = (body: { comm?: Record<string, unknown>; req?: { module: string; method: string; param?: unknown } }) =>
  | FakeResponse
  | Promise<FakeResponse>

const calls: Array<{ module: string; method: string; cookie: string }> = []
let handlers: Record<string, Handler> = {}

function fcgResponse(code: number, data?: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({ req: { code, data } }),
  }
}

function profileResponse(nick: string): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: { creator: { nick } } }),
  }
}

beforeEach(() => {
  calls.length = 0
  handlers = {}
  vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const isProfile = url.includes('fcg_get_profile_homepage')
    const cookie = init?.headers?.Cookie ?? ''
    if (isProfile) {
      calls.push({ module: 'profile_homepage', method: 'GET', cookie })
      const handler = handlers['profile_homepage']
      return handler ? handler({}) : profileResponse('Voidsd')
    }
    const parsed = JSON.parse(init?.body ?? '{}') as { req: { module: string; method: string } }
    const key = `${parsed.req.module}.${parsed.req.method}`
    calls.push({ module: parsed.req.module, method: parsed.req.method, cookie })
    const handler = handlers[key]
    if (!handler) throw new Error(`unexpected upstream call: ${key}`)
    return handler(parsed)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadModule() {
  vi.resetModules()
  return import('./tencentAuthService.js')
}

const PROBE = 'music.UserInfo.userInfoServer.GetLoginUserInfo'
const VIP = 'VipLogin.VipLoginInter.vip_login_base'
const VALID_COOKIE = 'uin=3046907223; qm_keyst=Q_H_L_fresh; qqmusic_key=Q_H_L_fresh'
const EXPIRED_COOKIE = 'uin=3046907223; qm_keyst=Q_H_L_stale; qqmusic_key=Q_H_L_stale'

describe('probeCredential', () => {
  it('reports valid when GetLoginUserInfo answers code 0', async () => {
    handlers[PROBE] = () => fcgResponse(0, { info: { nick: 'Voidsd' } })
    const mod = await loadModule()
    await expect(mod.probeCredential(VALID_COOKIE)).resolves.toBe('valid')
  })

  it.each([1000, 104400, 104401])('reports expired on auth failure code %i', async (code) => {
    handlers[PROBE] = () => fcgResponse(code)
    const mod = await loadModule()
    await expect(mod.probeCredential(VALID_COOKIE)).resolves.toBe('expired')
  })

  // 风控（500003）既没确认有效也没明确拒绝，绝不能据此把用户判成过期。
  it('does not treat upstream risk-control codes as expiry', async () => {
    handlers[PROBE] = () => fcgResponse(500003)
    const mod = await loadModule()
    await expect(mod.probeCredential(VALID_COOKIE)).resolves.toBe('unknown')
  })

  it('does not treat network failures as expiry', async () => {
    handlers[PROBE] = () => {
      throw new Error('ETIMEDOUT')
    }
    const mod = await loadModule()
    await expect(mod.probeCredential(VALID_COOKIE)).resolves.toBe('unknown')
  })

  it('does not treat HTTP errors as expiry', async () => {
    handlers[PROBE] = () => ({ ok: false, status: 502, json: async () => ({}) })
    const mod = await loadModule()
    await expect(mod.probeCredential(VALID_COOKIE)).resolves.toBe('unknown')
  })
})

describe('getUserInfo', () => {
  // 与真实响应一致：`svip` 在顶层，`identity` 里只有 `vip`。
  // （只读 identity.svip 会让超级会员永远被降级成普通 VIP。）
  beforeEach(() => {
    handlers[VIP] = () => fcgResponse(0, { identity: { vip: 1, level: 2 }, svip: 1 })
  })

  it('returns VIP info when the credential is genuinely valid', async () => {
    handlers[PROBE] = () => fcgResponse(0, { info: { nick: 'Voidsd' } })
    const mod = await loadModule()

    const result = await mod.getUserInfo(VALID_COOKIE)

    expect(result).toEqual({
      ok: true,
      data: { nickname: 'Voidsd', vipType: 2, userId: 3046907223, credentialVerified: true },
    })
  })

  // ===== 本次事故的核心回归 =====
  // 旧实现在这里返回 { ok: true, vipType: 0 }，导致 UI 显示「已登录但没有 VIP」。
  // vip_login_base 对失效凭证照样返回 code 0 + 全零 identity，因此必须由探针拦下。
  it('reports expired instead of "logged in without VIP" when the musickey is stale', async () => {
    handlers[PROBE] = () => fcgResponse(1000)
    // 失效凭证下 vip_login_base 依然「成功」并返回全零 —— 正是误导来源
    handlers[VIP] = () => fcgResponse(0, { identity: { vip: 0, level: 0 }, svip: 0 })
    const mod = await loadModule()

    const result = await mod.getUserInfo(EXPIRED_COOKIE)

    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  // 反向验证：如果把探针去掉（回到「只查 uin」的旧实现），上面的用例就会失败。
  it('still surfaces VIP level even when the profile endpoint has no nickname', async () => {
    handlers[PROBE] = () => fcgResponse(0, { info: {} })
    handlers['profile_homepage'] = () => profileResponse('Voidsd')
    const mod = await loadModule()

    const result = await mod.getUserInfo(VALID_COOKIE)

    expect(result).toMatchObject({ ok: true, data: { nickname: 'Voidsd' } })
  })

  it('marks credentialVerified=false when the probe is inconclusive', async () => {
    handlers[PROBE] = () => fcgResponse(500003)
    const mod = await loadModule()

    const result = await mod.getUserInfo(VALID_COOKIE)

    expect(result).toMatchObject({ ok: true, data: { credentialVerified: false, vipType: 2 } })
  })

  it('rejects a cookie that has no uin at all', async () => {
    const mod = await loadModule()
    await expect(mod.getUserInfo('qm_keyst=only-a-key')).resolves.toEqual({ ok: false, reason: 'no_token' })
  })

  // 探针在取证顺序上必须先于 VIP 查询：失效凭证不应再花一次上游请求去读 VIP。
  it('probes credential before querying VIP status', async () => {
    handlers[PROBE] = () => fcgResponse(1000)
    const mod = await loadModule()

    await mod.getUserInfo(EXPIRED_COOKIE)

    const modules = calls.map((c) => c.module)
    expect(modules).toContain('music.UserInfo.userInfoServer')
    expect(modules).not.toContain('VipLogin.VipLoginInter')
  })
})

describe('proactive musickey refresh', () => {
  const REFRESH = 'music.login.LoginServer.Login'
  const COOKIE_WITH_META =
    'uin=3046907223; qm_keyst=Q_H_L_old; qqmusic_key=Q_H_L_old; o_cookie=3046907223; o_refresh_token=RT'

  it('rotates the cookie when the musickey is close to expiry', async () => {
    handlers[PROBE] = () => fcgResponse(0, { info: { nick: 'Voidsd' } })
    handlers[VIP] = () => fcgResponse(0, { identity: { vip: 1 }, svip: 1 })
    handlers[REFRESH] = () =>
      fcgResponse(0, {
        musickey: 'Q_H_L_new',
        musicid: 3046907223,
        refresh_token: 'RT',
        openid: 'OPENID',
        access_token: 'AT',
        expired_at: Math.floor(Date.now() / 1000) + 60 * 86_400,
      })
    const mod = await loadModule()

    // 旧格式 Cookie 没有 o_expired_at → 视为「未知到期时间」，触发一次续期以迁移格式
    const result = await mod.getUserInfo(COOKIE_WITH_META)

    expect(result).toMatchObject({ ok: true })
    const refreshed = result.ok ? result.data.refreshedCookie : undefined
    expect(refreshed).toBeDefined()
    expect(refreshed).toContain('qm_keyst=Q_H_L_new')
    expect(refreshed).toContain('o_openid=OPENID')
    expect(refreshed).toContain('o_access_token=AT')
    // 原有字段必须保留，不能被续期覆盖丢失
    expect(refreshed).toContain('o_refresh_token=RT')
    expect(refreshed).toContain('uin=3046907223')
  })

  it('does not attempt a refresh once the musickey is already expired', async () => {
    // 过期后续期必定失败（实测 code 1000），不该浪费一次上游请求
    handlers[PROBE] = () => fcgResponse(1000)
    handlers[REFRESH] = () => {
      throw new Error('refresh must not be called on an expired credential')
    }
    const mod = await loadModule()

    const result = await mod.getUserInfo(COOKIE_WITH_META)

    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('keeps the original cookie when the refresh fails', async () => {
    handlers[PROBE] = () => fcgResponse(0, { info: { nick: 'Voidsd' } })
    handlers[VIP] = () => fcgResponse(0, { identity: { vip: 1 } })
    handlers[REFRESH] = () => fcgResponse(1000)
    const mod = await loadModule()

    const result = await mod.getUserInfo(COOKIE_WITH_META)

    expect(result).toMatchObject({ ok: true })
    // 续期失败时必须保留原 Cookie（不返回 refreshedCookie），避免把凭证改坏
    expect(result.ok && result.data.refreshedCookie).toBeUndefined()
  })
})

