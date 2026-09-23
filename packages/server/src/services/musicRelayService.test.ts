import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENTS } from '@music-together/shared'
import { musicRelayService } from './musicRelayService.js'

const VALID_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&callback=cb&data=1'

function makeIo() {
  const emit = vi.fn()
  const io = { to: vi.fn(() => ({ emit })) }
  return { io, emit }
}

describe('musicRelayService', () => {
  let io: { to: ReturnType<typeof vi.fn> }
  let emit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    ;({ io, emit } = makeIo())
    musicRelayService.setIo(io as never)
  })

  afterEach(() => {
    musicRelayService.setIo(null as never)
    musicRelayService.reset()
    vi.useRealTimers()
  })

  it('rejects non-whitelisted URLs without emitting', async () => {
    const result = await musicRelayService.requestJson('https://evil.example/proxy?url=x')

    expect(result).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('emits to an enabled client and resolves with the relayed data', async () => {
    musicRelayService.setRelayEnabled('sock-a', true)

    const promise = musicRelayService.requestJson(VALID_URL)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(EVENTS.MUSIC_RELAY_REQUEST, expect.objectContaining({ url: VALID_URL }))
    const requestId = emit.mock.calls[0]![1]!.requestId as string

    musicRelayService.handleResponse('sock-a', requestId, true, { code: 0 })

    await expect(promise).resolves.toEqual({ code: 0 })
  })

  it('does not emit when no client has relay enabled', async () => {
    const result = await musicRelayService.requestJson(VALID_URL)

    expect(result).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('times out when the client does not respond', async () => {
    musicRelayService.setRelayEnabled('sock-a', true)

    const promise = musicRelayService.requestJson(VALID_URL)

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(promise).resolves.toBeNull()
  })

  it('skips a busy client and uses the next enabled one', async () => {
    musicRelayService.setRelayEnabled('sock-a', true)
    musicRelayService.setRelayEnabled('sock-b', true)

    // 占用 sock-a
    const first = musicRelayService.requestJson(VALID_URL)
    // 第二次请求应落到 sock-b
    const second = musicRelayService.requestJson(VALID_URL)

    expect(emit).toHaveBeenCalledTimes(2)
    const firstTarget = io.to.mock.calls[0]![0] as string
    const secondTarget = io.to.mock.calls[1]![0] as string
    expect(firstTarget).toBe('sock-a')
    expect(secondTarget).toBe('sock-b')

    const secondRequestId = emit.mock.calls[1]![1]!.requestId as string
    musicRelayService.handleResponse('sock-b', secondRequestId, true, { purl: 'ok' })

    await expect(second).resolves.toEqual({ purl: 'ok' })

    // sock-a 的请求随后超时
    // sock-a 超时后服务会改试 sock-b（每个客户端每次调用只尝试一次），再超时后才结束
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(first).resolves.toBeNull()
  })

  it('cancels pending requests and removes the client on disconnect', async () => {
    musicRelayService.setRelayEnabled('sock-a', true)

    const promise = musicRelayService.requestJson(VALID_URL)
    expect(emit).toHaveBeenCalledTimes(1)

    musicRelayService.handleDisconnect('sock-a')

    // 断线不再立即丢弃 pending（重连发生在断线之后），改由请求自身超时兜底
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toBeNull()

    // 断线后不再向该客户端发送请求（enabled 已清除）
    await musicRelayService.requestJson(VALID_URL)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  // --- 重连健壮性（生产事故回归）------------------------------------------
  // 事故：成员 socket 因传输错误重连会换 socketId。旧实现把 pending 绑死在
  // socketId 上并静默丢弃，于是响应被无声吞掉——既没有成功日志也没有超时日志。

  it('keeps a pending request alive when the same member reconnects with a new socket', async () => {
    musicRelayService.setRelayEnabled('sock-old', true, 'user-1')

    const promise = musicRelayService.requestJson(VALID_URL)
    const requestId = emit.mock.calls[0]![1]!.requestId as string

    // 传输错误导致断线，随后同一成员建立了新 socket 并同样开启中继
    musicRelayService.handleDisconnect('sock-old')
    musicRelayService.setRelayEnabled('sock-new', true, 'user-1')

    // 响应来自新 socket，但属于同一身份 —— 必须被采纳
    musicRelayService.handleResponse('sock-new', requestId, true, { code: 0, purl: 'after-reconnect' })

    await expect(promise).resolves.toEqual({ code: 0, purl: 'after-reconnect' })
  })

  it('drops a pending request when the member disconnects without reconnecting', async () => {
    musicRelayService.setRelayEnabled('sock-old', true, 'user-1')

    const promise = musicRelayService.requestJson(VALID_URL)
    musicRelayService.handleDisconnect('sock-old')

    // 无人回传 -> 由请求自身超时兜底，且必须真正结束（不能永久挂起）
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(promise).resolves.toBeNull()
  })

  it('rejects a response from a different member', async () => {
    musicRelayService.setRelayEnabled('sock-a', true, 'user-1')
    musicRelayService.setRelayEnabled('sock-b', true, 'user-2')

    const promise = musicRelayService.requestJson(VALID_URL)
    const requestId = emit.mock.calls[0]![1]!.requestId as string

    // user-2 冒名回传：不是目标客户端，也不是同一身份 —— 必须被拒绝
    musicRelayService.handleResponse('sock-b', requestId, true, { stolen: true })

    // 真正的目标随后回传，仍然有效
    musicRelayService.handleResponse('sock-a', requestId, true, { legit: true })
    await expect(promise).resolves.toEqual({ legit: true })
  })

  it('ignores a response for an unknown request id', async () => {
    musicRelayService.setRelayEnabled('sock-a', true, 'user-1')

    const promise = musicRelayService.requestJson(VALID_URL)
    musicRelayService.handleResponse('sock-a', 'nonexistent-request', true, { nope: true })

    // 无关请求 id 不得影响真正的 pending 请求
    const requestId = emit.mock.calls[0]![1]!.requestId as string
    musicRelayService.handleResponse('sock-a', requestId, true, { real: true })
    await expect(promise).resolves.toEqual({ real: true })
  })
})
