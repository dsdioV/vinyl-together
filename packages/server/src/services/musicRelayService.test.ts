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

    await expect(promise).resolves.toBeNull()

    // 断线后不再向该客户端发送请求
    await musicRelayService.requestJson(VALID_URL)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
