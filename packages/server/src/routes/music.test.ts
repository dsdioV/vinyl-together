import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const getTrackByIdMock = vi.hoisted(() => vi.fn())

vi.mock('../services/musicProvider.js', () => ({
  musicProvider: { getTrackById: getTrackByIdMock },
}))

import musicRouter from './music.js'
import { KugouShortCodeError } from '../services/kugouShortCodeService.js'

describe('GET /track', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = express()
    app.use('/', musicRouter)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  beforeEach(() => {
    getTrackByIdMock.mockReset()
  })

  it('preserves a safe, actionable Kugou security error', async () => {
    getTrackByIdMock.mockRejectedValue(
      new KugouShortCodeError(
        'KUGOU_SECURITY_VERIFICATION_REQUIRED',
        '酷狗暂时要求安全验证，请稍后重试',
        429,
      ),
    )

    const response = await fetch(`${baseUrl}/track?source=kugou&id=j2hixca`)
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({
      error: '酷狗暂时要求安全验证，请稍后重试',
      code: 'KUGOU_SECURITY_VERIFICATION_REQUIRED',
    })
  })

  it('returns 404 for an unresolved ordinary track', async () => {
    getTrackByIdMock.mockResolvedValue(null)

    const response = await fetch(`${baseUrl}/track?source=netease&id=12345`)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: '歌曲未找到' })
  })
})
