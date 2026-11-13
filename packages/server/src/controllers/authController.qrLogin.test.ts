import { EVENTS, QR_STATUS } from '@music-together/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

const mocks = vi.hoisted(() => ({
  checkQrStatus: vi.fn(),
  getUserInfo: vi.fn(),
  addCookie: vi.fn(),
  getUserAuthStatus: vi.fn(() => []),
  getAllPlatformStatus: vi.fn(() => []),
  getSocketMapping: vi.fn(),
}))

vi.mock('../services/authProvider.js', () => ({
  AUTH_PROVIDERS: {
    netease: { checkQrStatus: mocks.checkQrStatus, getUserInfo: mocks.getUserInfo },
    kugou: { checkQrStatus: mocks.checkQrStatus, getUserInfo: mocks.getUserInfo },
    tencent: { checkQrStatus: mocks.checkQrStatus, getUserInfo: mocks.getUserInfo },
  },
}))

vi.mock('../services/authService.js', () => ({
  addCookie: mocks.addCookie,
  getUserAuthStatus: mocks.getUserAuthStatus,
  getAllPlatformStatus: mocks.getAllPlatformStatus,
}))

vi.mock('../repositories/roomRepository.js', () => ({
  roomRepo: { getSocketMapping: mocks.getSocketMapping },
}))

import { registerAuthController } from './authController.js'

type Handler = (data?: unknown) => void | Promise<void>

interface Harness {
  handlers: Map<string, Handler>
  socketEmit: ReturnType<typeof vi.fn>
  ioToEmit: ReturnType<typeof vi.fn>
  dispatch: (event: string, data?: unknown) => Promise<void>
}

function makeHarness(): Harness {
  const handlers = new Map<string, Handler>()
  const socketEmit = vi.fn()
  const ioToEmit = vi.fn()
  const socket = {
    id: 'socket-1',
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler)
    },
    emit: socketEmit,
  } as unknown as TypedSocket
  const io = { to: () => ({ emit: ioToEmit }) } as unknown as TypedServer

  registerAuthController(io, socket)

  return {
    handlers,
    socketEmit,
    ioToEmit,
    dispatch: async (event, data) => {
      const handler = handlers.get(event)
      if (!handler) throw new Error(`no handler for ${event}`)
      await handler(data)
    },
  }
}

const SUCCESS_COOKIE = 'uin=123456; qm_keyst=abc'
const USER_INFO = { ok: true as const, data: { nickname: 'Voidsd', vipType: 1, userId: 123456 } }

describe('AUTH_CHECK_QR success path', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.getSocketMapping.mockReturnValue({ roomId: 'room-1', userId: 'user-1' })
    mocks.checkQrStatus.mockResolvedValue({ status: QR_STATUS.SUCCESS, message: '登录成功', cookie: SUCCESS_COOKIE })
    mocks.getUserInfo.mockResolvedValue(USER_INFO)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function cookieResults(harness: Harness) {
    return harness.socketEmit.mock.calls
      .filter(([event]) => event === EVENTS.AUTH_SET_COOKIE_RESULT)
      .map(([, payload]) => payload as { success: boolean; message: string; reason?: string })
  }

  it('stores the cookie and broadcasts the new status on success', async () => {
    const harness = makeHarness()
    await harness.dispatch(EVENTS.AUTH_CHECK_QR, { key: 'qr-key', platform: 'tencent' })

    // 第 7 个参数是 credentialVerified：undefined 表示该用例的 mock 未提供（等价于「不区分」）
    expect(mocks.addCookie).toHaveBeenCalledWith('room-1', 'tencent', 'user-1', SUCCESS_COOKIE, 'Voidsd', 1, undefined)
    expect(harness.socketEmit).toHaveBeenCalledWith(EVENTS.AUTH_MY_STATUS, expect.anything())
    expect(harness.ioToEmit).toHaveBeenCalledWith(EVENTS.AUTH_STATUS_UPDATE, expect.anything())
    expect(cookieResults(harness)).toEqual([{ success: true, message: '已登录为 Voidsd', platform: 'tencent', cookie: SUCCESS_COOKIE }])
  })

  // 回归测试：二维码是一次性的，getUserInfo 的临时失败若不重试，
  // 用户扫码授权成功后会看到「登录成功但无法获取用户信息」，且无法补救。
  it('retries getUserInfo once on a transient error', async () => {
    mocks.getUserInfo.mockResolvedValueOnce({ ok: false, reason: 'error' }).mockResolvedValueOnce(USER_INFO)

    const harness = makeHarness()
    const pending = harness.dispatch(EVENTS.AUTH_CHECK_QR, { key: 'qr-key', platform: 'tencent' })
    await vi.advanceTimersByTimeAsync(1500)
    await pending

    expect(mocks.getUserInfo).toHaveBeenCalledTimes(2)
    expect(mocks.addCookie).toHaveBeenCalledTimes(1)
    expect(cookieResults(harness)[0]).toMatchObject({ success: true, message: '已登录为 Voidsd' })
  })

  it('reports failure when both attempts fail', async () => {
    mocks.getUserInfo.mockResolvedValue({ ok: false, reason: 'expired' })

    const harness = makeHarness()
    await harness.dispatch(EVENTS.AUTH_CHECK_QR, { key: 'qr-key', platform: 'tencent' })

    // expired 不是临时错误，不重试
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(1)
    expect(mocks.addCookie).not.toHaveBeenCalled()
    expect(cookieResults(harness)[0]).toMatchObject({ success: false, reason: 'expired' })
  })

  // 回归测试：socket 还没加入房间时，旧实现会广播 success:true 但什么都不写，
  // 前端因此显示「已登录」，而房间 Cookie 池里根本没有这条记录。
  it('does not report success when the socket has no room mapping', async () => {
    mocks.getSocketMapping.mockReturnValue(null)

    const harness = makeHarness()
    await harness.dispatch(EVENTS.AUTH_CHECK_QR, { key: 'qr-key', platform: 'tencent' })

    expect(mocks.addCookie).not.toHaveBeenCalled()
    const results = cookieResults(harness)
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].message).toContain('未加入房间')
  })

  it('only handles a single 803 per QR session', async () => {
    const harness = makeHarness()
    await harness.dispatch(EVENTS.AUTH_CHECK_QR, { key: 'qr-key', platform: 'tencent' })
    await harness.dispatch(EVENTS.AUTH_CHECK_QR, { key: 'qr-key', platform: 'tencent' })

    expect(mocks.getUserInfo).toHaveBeenCalledTimes(1)
    expect(mocks.addCookie).toHaveBeenCalledTimes(1)
  })
})
