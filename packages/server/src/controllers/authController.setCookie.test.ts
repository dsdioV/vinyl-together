import { EVENTS } from '@music-together/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

/**
 * AUTH_SET_COOKIE 的过期处理回归测试。
 *
 * 事故背景（2026-11-13）：旧实现只对 `platform === 'netease'` 拒收 expired，
 * QQ 音乐与酷狗走「验证失败也保存」的兜底分支。于是 QQ 的过期凭证被当成
 * 「已登录的非 VIP 用户」写进房间池 —— 用户看到自己的名字旁没有 VIP 徽章、
 * 点 VIP 歌曲失败，却完全不知道是登录过期。
 */

const mocks = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  addCookie: vi.fn(),
  markCredentialExpired: vi.fn(),
  isCredentialExpired: vi.fn(() => false),
  hasCookie: vi.fn(() => false),
  getUserAuthStatus: vi.fn(() => []),
  getAllPlatformStatus: vi.fn(() => []),
  getSocketMapping: vi.fn(),
}))

vi.mock('../services/authProvider.js', () => ({
  AUTH_PROVIDERS: {
    netease: { getUserInfo: mocks.getUserInfo, generateQrCode: vi.fn(), checkQrStatus: vi.fn(), getUserPlaylists: vi.fn() },
    kugou: { getUserInfo: mocks.getUserInfo, generateQrCode: vi.fn(), checkQrStatus: vi.fn(), getUserPlaylists: vi.fn() },
    tencent: { getUserInfo: mocks.getUserInfo, generateQrCode: vi.fn(), checkQrStatus: vi.fn(), getUserPlaylists: vi.fn() },
  },
}))

vi.mock('../services/authService.js', () => ({
  addCookie: mocks.addCookie,
  markCredentialExpired: mocks.markCredentialExpired,
  isCredentialExpired: mocks.isCredentialExpired,
  hasCookie: mocks.hasCookie,
  removeCookie: vi.fn(),
  getUserAuthStatus: mocks.getUserAuthStatus,
  getAllPlatformStatus: mocks.getAllPlatformStatus,
}))

vi.mock('../repositories/roomRepository.js', () => ({
  roomRepo: { getSocketMapping: mocks.getSocketMapping },
}))

import { registerAuthController } from './authController.js'

type Handler = (data?: unknown) => void | Promise<void>

function makeHarness() {
  const handlers = new Map<string, Handler>()
  const socketEmit = vi.fn()
  const socket = {
    id: 'socket-1',
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: socketEmit,
  } as unknown as TypedSocket
  const io = { to: () => ({ emit: vi.fn() }) } as unknown as TypedServer

  registerAuthController(io, socket)

  return {
    socketEmit,
    dispatch: async (event: string, data?: unknown) => {
      const handler = handlers.get(event)
      if (!handler) throw new Error(`no handler for ${event}`)
      await handler(data)
    },
    results: () =>
      socketEmit.mock.calls
        .filter(([event]) => event === EVENTS.AUTH_SET_COOKIE_RESULT)
        .map(([, payload]) => payload as { success: boolean; message: string; reason?: string }),
  }
}

const COOKIE = 'uin=3046907223; qm_keyst=Q_H_L_stale'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSocketMapping.mockReturnValue({ roomId: 'room-1', userId: 'user-1' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AUTH_SET_COOKIE — expired credentials', () => {
  // ===== 本次事故的核心回归 =====
  // 反向验证：把 platform 特殊判断改回「只对 netease 拒收」时，这个用例会失败。
  it('rejects an expired QQ credential instead of storing it as "logged in without VIP"', async () => {
    mocks.getUserInfo.mockResolvedValue({ ok: false, reason: 'expired' })

    const h = makeHarness()
    await h.dispatch(EVENTS.AUTH_SET_COOKIE, { platform: 'tencent', cookie: COOKIE })

    expect(mocks.addCookie).not.toHaveBeenCalled()
    expect(mocks.markCredentialExpired).toHaveBeenCalledWith('room-1', 'tencent', 'user-1')
    expect(h.results()[0]).toMatchObject({ success: false, reason: 'expired' })
    expect(h.results()[0]?.message).toContain('过期')
  })

  it('rejects expired credentials for netease as well', async () => {
    mocks.getUserInfo.mockResolvedValue({ ok: false, reason: 'expired' })

    const h = makeHarness()
    await h.dispatch(EVENTS.AUTH_SET_COOKIE, { platform: 'netease', cookie: 'MUSIC_U=stale' })

    expect(mocks.addCookie).not.toHaveBeenCalled()
    expect(h.results()[0]).toMatchObject({ success: false, reason: 'expired' })
  })

  it('does not claim success when QQ music cannot verify the credential', async () => {
    // 网络/风控：既非有效也非过期。旧实现会在这里宣称「已保存，播放时生效」，
    // 让用户以为登录成功，然后点歌失败。
    mocks.getUserInfo.mockResolvedValue({ ok: false, reason: 'error' })

    const h = makeHarness()
    await h.dispatch(EVENTS.AUTH_SET_COOKIE, { platform: 'tencent', cookie: COOKIE })

    expect(mocks.addCookie).not.toHaveBeenCalled()
    expect(h.results()[0]).toMatchObject({ success: false, reason: 'error' })
  })

  it('still stores a verified credential and forwards credentialVerified', async () => {
    mocks.getUserInfo.mockResolvedValue({
      ok: true,
      data: { nickname: 'Voidsd', vipType: 2, userId: 3046907223, credentialVerified: true },
    })

    const h = makeHarness()
    await h.dispatch(EVENTS.AUTH_SET_COOKIE, { platform: 'tencent', cookie: COOKIE })

    expect(mocks.addCookie).toHaveBeenCalledWith('room-1', 'tencent', 'user-1', COOKIE, 'Voidsd', 2, true)
    expect(h.results()[0]).toMatchObject({ success: true, credentialVerified: true })
  })

  it('keeps the kugou "save anyway" fallback for transient failures', async () => {
    // 酷狗的 getPlayUrl 路径不依赖 getUserInfo 的结论，保留原有兜底行为。
    mocks.getUserInfo.mockResolvedValue({ ok: false, reason: 'error' })

    const h = makeHarness()
    await h.dispatch(EVENTS.AUTH_SET_COOKIE, { platform: 'kugou', cookie: 'token=abc;userid=123' })

    expect(mocks.addCookie).toHaveBeenCalledWith('room-1', 'kugou', 'user-1', 'token=abc;userid=123', '手动登录', 0)
    expect(h.results()[0]).toMatchObject({ success: true })
  })

  // 酷狗的 expired 语义不可靠：kugouAuthService 在「VIP 接口没返回数据」时就返回
  // expired，那可能只是一次上游抖动。不能因此把可用的酷狗凭证拒收掉。
  // 反向验证：把 EXPIRY_IS_DEFINITIVE 改成包含 kugou，这个用例会失败。
  it('does not reject kugou on "expired", whose semantics are unreliable', async () => {
    mocks.getUserInfo.mockResolvedValue({ ok: false, reason: 'expired' })

    const h = makeHarness()
    await h.dispatch(EVENTS.AUTH_SET_COOKIE, { platform: 'kugou', cookie: 'token=abc;userid=123' })

    expect(mocks.addCookie).toHaveBeenCalled()
    expect(mocks.markCredentialExpired).not.toHaveBeenCalled()
    expect(h.results()[0]).toMatchObject({ success: true })
  })
})
