import express from 'express'
import { connect, type Socket } from 'node:net'
import type { Server } from 'node:http'
import path from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODE } from '@music-together/shared'

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  createTask: vi.fn(),
  receiveUpload: vi.fn(),
  cancelTask: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
  getVariant: vi.fn(),
  beginStream: vi.fn(),
}))

vi.mock('../services/localAudioService.js', () => ({
  localAudioService: mocks,
  localAudioErrorPayload: vi.fn(() => ({ code: 'LOCAL_AUDIO_INVALID', message: 'invalid local audio request' })),
}))

import { config } from '../config.js'
import { identityHttpMiddleware } from '../middleware/identityHttp.js'
import {
  LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE,
  LOCAL_AUDIO_HTTP_RATE_LIMITS,
} from '../middleware/localAudioHttpRateLimiter.js'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'
import { issueIdentityCookie } from '../services/identityService.js'
import { issueLocalAudioAccessToken } from '../services/localAudioAccess.js'
import localAudioRouter from './localAudio.js'

let server: Server
let baseUrl = ''
let fixtureDir = ''
let fixturePath = ''
const fixtureBytes = Buffer.from('0123456789', 'utf8')
const mountedRoomIds: string[] = []

beforeAll(async () => {
  fixtureDir = path.join(config.localAudio.dataDir, `.route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fixturePath = path.join(fixtureDir, 'asset.mp3')
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(fixturePath, fixtureBytes)

  const app = express()
  // A test-only identity issuer lets the router run behind the same identity
  // middleware used by the production app without depending on a cookie library.
  app.get('/__test/login/:userId', (req, res) => {
    issueIdentityCookie(req, res, req.params.userId)
    res.status(204).end()
  })
  app.use(identityHttpMiddleware)
  app.use('/', localAudioRouter)
  // Keep the production order: local-audio routes are mounted before the
  // global JSON parser so identity/membership checks run before a raw upload
  // body can be consumed. The router owns its small JSON parsers.
  app.use(express.json({ limit: '1mb' }))

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  for (const roomId of mountedRoomIds.splice(0)) roomRepo.delete(roomId)
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  await rm(fixtureDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshot.mockReturnValue({ tasks: [], assets: [], usage: { finalBytes: 0, tempBytes: 0 } })
  mocks.beginStream.mockReturnValue(vi.fn())
  mocks.getVariant.mockImplementation((_roomId: string, assetId: string) => {
    if (assetId !== 'asset-1') return null
    return {
      path: fixturePath,
      size: fixtureBytes.length,
      contentType: 'audio/mpeg',
      asset: {},
    }
  })
  for (const roomId of mountedRoomIds.splice(0)) roomRepo.delete(roomId)
})

function mountRoom(roomId = 'ROOM1', userId = 'member-1'): void {
  roomRepo.set(roomId, {
    id: roomId,
    users: [{ id: userId, nickname: userId, role: 'member' }],
  } as RoomData)
  mountedRoomIds.push(roomId)
}

async function cookieFor(userId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/__test/login/${encodeURIComponent(userId)}`)
  expect(response.status).toBe(204)
  const header = response.headers.get('set-cookie')
  if (!header) throw new Error('Test identity endpoint did not issue a cookie')
  return header.split(';', 1)[0]!
}

function assetUrl(roomId = 'ROOM1', assetId = 'asset-1', variant = 'stream', token?: string): string {
  const url = new URL(`${baseUrl}/${roomId}/local-audio/assets/${assetId}/${variant}`)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

/** Send only request headers, which models a client that has not started its upload body yet. */
async function sendHeadersOnly(pathname: string, headers: Record<string, string>): Promise<string> {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server is not listening')
  return await new Promise<string>((resolve, reject) => {
    const socket: Socket = connect(address.port, '127.0.0.1')
    let responseText = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for early HTTP response'))
    }, 2_000)
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.on('data', (chunk: Buffer) => {
      responseText += chunk.toString('latin1')
      if (responseText.includes('\r\n\r\n')) {
        clearTimeout(timeout)
        socket.destroy()
        resolve(responseText)
      }
    })
    socket.once('connect', () => {
      const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
      socket.write(
        [`PUT ${pathname} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close', ...headerLines, '', ''].join('\r\n'),
      )
    })
  })
}

describe('local audio route authentication', () => {
  it('returns 401 without identity and does not call the service', async () => {
    mountRoom()

    const response = await fetch(`${baseUrl}/ROOM1/local-audio`)

    expect(response.status).toBe(401)
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated large upload before parsing a forged JSON body', async () => {
    mountRoom()

    const rawResponse = await sendHeadersOnly('/ROOM1/local-audio/tasks/task-1/content', {
      'Content-Type': 'application/json',
      'Content-Length': String(500 * 1024 * 1024),
    })

    expect(rawResponse).toMatch(/^HTTP\/1\.1 401(?: Unauthorized)?\r\n/)
    expect(mocks.receiveUpload).not.toHaveBeenCalled()
  })

  it('returns 403 for an authenticated user who is not a room member', async () => {
    mountRoom()
    const cookie = await cookieFor('outsider')

    const response = await fetch(`${baseUrl}/ROOM1/local-audio`, { headers: { cookie } })

    expect(response.status).toBe(403)
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it('rejects the upload body before it is sent when the caller is unauthenticated', async () => {
    mountRoom()

    const rawResponse = await sendHeadersOnly('/ROOM1/local-audio/tasks/task-1/content', {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(500 * 1024 * 1024),
    })

    expect(rawResponse).toMatch(/^HTTP\/1\.1 401(?: Unauthorized)?\r\n/)
    expect(mocks.receiveUpload).not.toHaveBeenCalled()
  })

  it('rejects task creation before invoking the service for a non-member', async () => {
    mountRoom()
    const cookie = await cookieFor('outsider')

    const response = await fetch(`${baseUrl}/ROOM1/local-audio/tasks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'large.mp3', fileSize: 500 * 1024 * 1024, addToQueue: true }),
    })

    expect(response.status).toBe(403)
    expect(mocks.createTask).not.toHaveBeenCalled()
  })
})

describe('local audio HTTP control-plane rate limiting', () => {
  it('rate-limits the shared mutation bucket before any further service call', async () => {
    const roomId = 'RATE1'
    const userId = 'rate-member-1'
    mountRoom(roomId, userId)
    const cookie = await cookieFor(userId)
    mocks.updateAsset.mockReturnValue({ id: 'asset-1' })

    for (let index = 0; index < LOCAL_AUDIO_HTTP_RATE_LIMITS.mutation.points; index += 1) {
      const response = await fetch(`${baseUrl}/${roomId}/local-audio/assets/asset-1`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Title ${index}` }),
      })
      expect(response.status).toBe(200)
    }
    expect(mocks.updateAsset).toHaveBeenCalledTimes(LOCAL_AUDIO_HTTP_RATE_LIMITS.mutation.points)

    const limitedPatch = await fetch(`${baseUrl}/${roomId}/local-audio/assets/asset-1`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'One request too many' }),
    })
    expect(limitedPatch.status).toBe(429)
    expect(await limitedPatch.json()).toEqual({
      error: LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE,
      code: ERROR_CODE.RATE_LIMITED,
      message: LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE,
    })
    expect(mocks.updateAsset).toHaveBeenCalledTimes(LOCAL_AUDIO_HTTP_RATE_LIMITS.mutation.points)

    const blockedResponses = await Promise.all([
      fetch(`${baseUrl}/${roomId}/local-audio/tasks`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'song.mp3', fileSize: 123, addToQueue: true }),
      }),
      fetch(`${baseUrl}/${roomId}/local-audio/tasks/task-1`, { method: 'DELETE', headers: { cookie } }),
      fetch(`${baseUrl}/${roomId}/local-audio/assets/asset-1`, { method: 'DELETE', headers: { cookie } }),
      fetch(`${baseUrl}/${roomId}/local-audio/tasks/task-1/content`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/octet-stream' },
        body: fixtureBytes,
      }),
    ])

    expect(blockedResponses.map((response) => response.status)).toEqual([429, 429, 429, 429])
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.cancelTask).not.toHaveBeenCalled()
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
    expect(mocks.receiveUpload).not.toHaveBeenCalled()

    const snapshotResponse = await fetch(`${baseUrl}/${roomId}/local-audio`, { headers: { cookie } })
    expect(snapshotResponse.status).toBe(200)
    expect(mocks.snapshot).toHaveBeenCalledWith(roomId)
  })

  it('does not charge a user bucket until room membership has been verified', async () => {
    const roomId = 'RATE2'
    const userId = 'future-member'
    mountRoom(roomId, 'existing-member')
    const cookie = await cookieFor(userId)

    for (let index = 0; index <= LOCAL_AUDIO_HTTP_RATE_LIMITS.mutation.points; index += 1) {
      const response = await fetch(`${baseUrl}/${roomId}/local-audio/assets/asset-1`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Rejected ${index}` }),
      })
      expect(response.status).toBe(403)
    }
    expect(mocks.updateAsset).not.toHaveBeenCalled()

    roomRepo.set(roomId, {
      id: roomId,
      users: [{ id: userId, nickname: userId, role: 'member' }],
    } as RoomData)
    mocks.updateAsset.mockReturnValue({ id: 'asset-1' })

    const response = await fetch(`${baseUrl}/${roomId}/local-audio/assets/asset-1`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Now authorized' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.updateAsset).toHaveBeenCalledTimes(1)
  })
})

describe('local audio media access', () => {
  it('accepts a correctly signed room-bound token', async () => {
    mountRoom()
    const token = issueLocalAudioAccessToken('ROOM1', 'asset-1', 'primary')

    const response = await fetch(assetUrl('ROOM1', 'asset-1', 'stream', token))

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtureBytes)
  })

  it('allows a current room member to access media without a stream token', async () => {
    mountRoom()
    const cookie = await cookieFor('member-1')

    const response = await fetch(assetUrl(), { headers: { cookie } })

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtureBytes)
  })

  it('rejects a valid token issued for another room', async () => {
    mountRoom('ROOM1')
    mountRoom('ROOM2', 'other-member')
    const token = issueLocalAudioAccessToken('ROOM2', 'asset-1', 'primary')

    const response = await fetch(assetUrl('ROOM1', 'asset-1', 'stream', token))

    expect(response.status).toBe(401)
    expect(mocks.getVariant).not.toHaveBeenCalled()
  })

  it('binds tokens to their media variant', async () => {
    mountRoom('ROOM1')
    const token = issueLocalAudioAccessToken('ROOM1', 'asset-1', 'primary')

    const response = await fetch(assetUrl('ROOM1', 'asset-1', 'fallback', token))

    expect(response.status).toBe(401)
    expect(mocks.getVariant).not.toHaveBeenCalled()
  })

  it('serves 200 and 206 HEAD responses with the correct byte metadata', async () => {
    mountRoom()
    const cookie = await cookieFor('member-1')

    const full = await fetch(assetUrl(), { method: 'HEAD', headers: { cookie } })
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-length')).toBe(String(fixtureBytes.length))
    expect((await full.arrayBuffer()).byteLength).toBe(0)

    const partial = await fetch(assetUrl(), {
      method: 'HEAD',
      headers: { cookie, range: 'bytes=2-5' },
    })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 2-5/${fixtureBytes.length}`)
    expect(partial.headers.get('content-length')).toBe('4')
    expect((await partial.arrayBuffer()).byteLength).toBe(0)
  })

  it('returns 416 for an unsatisfiable byte range', async () => {
    mountRoom()
    const cookie = await cookieFor('member-1')

    const response = await fetch(assetUrl(), {
      headers: { cookie, range: 'bytes=100-200' },
    })

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${fixtureBytes.length}`)
    expect(mocks.beginStream).not.toHaveBeenCalled()
  })

  it('rejects unknown variants, malformed asset IDs, and paths outside the data root', async () => {
    mountRoom()
    const cookie = await cookieFor('member-1')

    const unknownVariant = await fetch(assetUrl('ROOM1', 'asset-1', 'download'), { headers: { cookie } })
    expect(unknownVariant.status).toBe(404)
    expect(mocks.getVariant).not.toHaveBeenCalled()

    const malformedAsset = await fetch(assetUrl('ROOM1', 'asset.invalid', 'stream'), { headers: { cookie } })
    expect(malformedAsset.status).toBe(404)
    expect(mocks.getVariant).not.toHaveBeenCalled()

    mocks.getVariant.mockReturnValueOnce({
      path: path.resolve(config.localAudio.dataDir, '..', 'outside.mp3'),
      size: fixtureBytes.length,
      contentType: 'audio/mpeg',
      asset: {},
    })
    const outsidePath = await fetch(assetUrl(), { headers: { cookie } })
    expect(outsidePath.status).toBe(404)
    expect(mocks.beginStream).not.toHaveBeenCalled()
  })
})
