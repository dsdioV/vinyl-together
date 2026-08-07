import express from 'express'
import type { Server } from 'node:http'
import { LIMITS, type DefaultQueueTrackRef, type User } from '@music-together/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MockPlaylistSearchLimitError extends Error {
    readonly code = 'PLAYLIST_TRACK_LIMIT_EXCEEDED'
    readonly maxTracks = 10_000

    constructor(readonly actualTracks?: number) {
      super(
        actualTracks === undefined
          ? '歌单超过支持上限 10000 首'
          : `歌单包含 ${actualTracks} 首歌曲，超过支持上限 10000 首`,
      )
      this.name = 'PlaylistSearchLimitError'
    }
  }

  return {
    getTrackById: vi.fn(),
    getPlaylistPage: vi.fn(),
    searchPlaylistTracks: vi.fn(),
    getUserCookie: vi.fn(),
    getAnyCookie: vi.fn(),
    PlaylistSearchLimitError: MockPlaylistSearchLimitError,
  }
})

vi.mock('../services/musicProvider.js', () => ({
  musicProvider: {
    getTrackById: mocks.getTrackById,
    getPlaylistPage: mocks.getPlaylistPage,
    searchPlaylistTracks: mocks.searchPlaylistTracks,
  },
  PlaylistSearchLimitError: mocks.PlaylistSearchLimitError,
}))

vi.mock('../services/authService.js', () => ({
  getUserCookie: mocks.getUserCookie,
  getAnyCookie: mocks.getAnyCookie,
}))

import musicRouter from './music.js'
import { PlaylistSearchLimitError } from '../services/musicProvider.js'
import { KugouShortCodeError } from '../services/kugouShortCodeService.js'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'

let server: Server
let baseUrl: string
const mountedRoomIds: string[] = []

beforeAll(async () => {
  const app = express()
  app.use((req, _res, next) => {
    req.identityUserId = req.header('x-test-user-id') ?? undefined
    next()
  })
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
  vi.clearAllMocks()
  for (const roomId of mountedRoomIds.splice(0)) roomRepo.delete(roomId)
})

function mountRoom(roomId: string, userId: string, role: User['role'] = 'member'): void {
  roomRepo.set(roomId, {
    id: roomId,
    users: [{ id: userId, nickname: 'Tester', role }],
  } as RoomData)
  mountedRoomIds.push(roomId)
}

function mountDefaultQueueRoom(
  roomId: string,
  userId: string,
  role: User['role'],
  refs: DefaultQueueTrackRef[] = [],
): void {
  roomRepo.set(roomId, {
    id: roomId,
    users: [{ id: userId, nickname: 'Tester', role }],
    defaultQueue: refs,
  } as RoomData)
  mountedRoomIds.push(roomId)
}

function playlistSearchUrl(params: Record<string, string | number>): string {
  return `${baseUrl}/playlist/search?${new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  )}`
}

describe('GET /track', () => {
  it('preserves a safe, actionable Kugou security error', async () => {
    mocks.getTrackById.mockRejectedValue(
      new KugouShortCodeError('KUGOU_SECURITY_VERIFICATION_REQUIRED', '酷狗暂时要求安全验证，请稍后重试', 429),
    )

    const response = await fetch(`${baseUrl}/track?source=kugou&id=j2hixca`)
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({
      error: '酷狗暂时要求安全验证，请稍后重试',
      code: 'KUGOU_SECURITY_VERIFICATION_REQUIRED',
    })
  })

  it('returns 404 for an unresolved ordinary track', async () => {
    mocks.getTrackById.mockResolvedValue(null)

    const response = await fetch(`${baseUrl}/track?source=netease&id=12345`)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: '歌曲未找到' })
  })
})

describe('GET /playlist', () => {
  it('maps an oversized playlist to the same stable 422 response', async () => {
    const actualTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1
    mocks.getPlaylistPage.mockRejectedValue(new PlaylistSearchLimitError(actualTracks))

    const response = await fetch(
      `${baseUrl}/playlist?${new URLSearchParams({
        source: 'netease',
        id: 'large-playlist',
        total: String(actualTracks),
      })}`,
    )

    expect(response.status).toBe(422)
    expect(mocks.getPlaylistPage).toHaveBeenCalledWith(
      'netease',
      'large-playlist',
      100,
      0,
      actualTracks,
      null,
      'playlist',
    )
    await expect(response.json()).resolves.toEqual({
      error: `歌单包含 ${actualTracks} 首歌曲，超过支持上限 ${LIMITS.PLAYLIST_SEARCH_MAX_TRACKS} 首`,
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      maxTracks: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      actualTracks,
    })
  })
})

describe('GET /playlist/search', () => {
  it('searches the complete playlist with fixed 50-track pagination defaults', async () => {
    const tracks = [{ id: 'after-1000' }]
    mocks.searchPlaylistTracks.mockResolvedValue({ tracks, total: 1_500, hasMore: false })

    const response = await fetch(playlistSearchUrl({ source: 'netease', id: ' playlist-1 ', keyword: ' target song ' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ tracks, total: 1_500, page: 1, hasMore: false })
    expect(mocks.searchPlaylistTracks).toHaveBeenCalledWith(
      'netease',
      'playlist-1',
      'target song',
      1,
      50,
      undefined,
      null,
      'playlist',
    )
  })

  it('passes an authenticated room member cookie and playlist metadata to the provider', async () => {
    mountRoom('ROOM1', 'member-1')
    mocks.getUserCookie.mockReturnValue('vip-cookie')
    mocks.searchPlaylistTracks.mockResolvedValue({
      tracks: [],
      total: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      hasMore: false,
    })

    const response = await fetch(
      playlistSearchUrl({
        source: 'tencent',
        id: 'album-1',
        keyword: 'needle',
        page: LIMITS.PLAYLIST_SEARCH_PAGE_MAX,
        limit: LIMITS.PLAYLIST_SEARCH_PAGE_SIZE,
        total: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
        roomId: 'ROOM1',
        type: 'album',
      }),
      { headers: { 'x-test-user-id': 'member-1' } },
    )

    expect(response.status).toBe(200)
    expect(mocks.getUserCookie).toHaveBeenCalledWith('member-1', 'tencent', 'ROOM1')
    expect(mocks.searchPlaylistTracks).toHaveBeenCalledWith(
      'tencent',
      'album-1',
      'needle',
      LIMITS.PLAYLIST_SEARCH_PAGE_MAX,
      LIMITS.PLAYLIST_SEARCH_PAGE_SIZE,
      LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      'vip-cookie',
      'album',
    )
  })

  it('requires room identity and membership before using room-scoped credentials', async () => {
    mountRoom('ROOM2', 'member-2')

    const query = playlistSearchUrl({ source: 'kugou', id: 'playlist-2', keyword: 'needle', roomId: 'ROOM2' })
    const unauthenticated = await fetch(query)
    const nonMember = await fetch(query, { headers: { 'x-test-user-id': 'outsider' } })

    expect(unauthenticated.status).toBe(401)
    await expect(unauthenticated.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(nonMember.status).toBe(403)
    await expect(nonMember.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(mocks.getUserCookie).not.toHaveBeenCalled()
    expect(mocks.searchPlaylistTracks).not.toHaveBeenCalled()
  })

  it.each([
    ['blank keyword', { source: 'netease', id: 'playlist-1', keyword: '   ' }],
    ['oversized keyword', { source: 'netease', id: 'playlist-1', keyword: 'x'.repeat(501) }],
    ['blank playlist id', { source: 'netease', id: '', keyword: 'song' }],
    ['oversized playlist id', { source: 'netease', id: 'x'.repeat(201), keyword: 'song' }],
    ['page zero', { source: 'netease', id: 'playlist-1', keyword: 'song', page: 0 }],
    [
      'page above maximum',
      {
        source: 'netease',
        id: 'playlist-1',
        keyword: 'song',
        page: LIMITS.PLAYLIST_SEARCH_PAGE_MAX + 1,
      },
    ],
    ['non-fixed limit', { source: 'netease', id: 'playlist-1', keyword: 'song', limit: 49 }],
    ['oversized limit', { source: 'netease', id: 'playlist-1', keyword: 'song', limit: 51 }],
  ])('rejects %s', async (_label, params) => {
    const response = await fetch(playlistSearchUrl(params))

    expect(response.status).toBe(400)
    expect(mocks.searchPlaylistTracks).not.toHaveBeenCalled()
  })

  it('maps the recognizable over-10000 service error to a stable 422 response', async () => {
    const actualTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1
    mocks.searchPlaylistTracks.mockRejectedValue(new PlaylistSearchLimitError(actualTracks))

    const response = await fetch(
      playlistSearchUrl({
        source: 'netease',
        id: 'large-playlist',
        keyword: 'song',
        total: actualTracks,
      }),
    )

    expect(response.status).toBe(422)
    expect(mocks.searchPlaylistTracks).toHaveBeenCalledWith(
      'netease',
      'large-playlist',
      'song',
      1,
      50,
      actualTracks,
      null,
      'playlist',
    )
    await expect(response.json()).resolves.toEqual({
      error: `歌单包含 ${actualTracks} 首歌曲，超过支持上限 ${LIMITS.PLAYLIST_SEARCH_MAX_TRACKS} 首`,
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      maxTracks: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      actualTracks,
    })
  })
})

describe('GET /default-queue/tracks', () => {
  const makeRef = (id: string): DefaultQueueTrackRef => ({
    id,
    source: 'netease',
    sourceId: `source-${id}`,
    title: `Track ${id}`,
    artist: ['Test Artist'],
  })

  it('requires identity', async () => {
    mountDefaultQueueRoom('dq-room-unauth', 'u1', 'owner')

    const response = await fetch(`${baseUrl}/default-queue/tracks?roomId=dq-room-unauth&ids=a`)

    expect(response.status).toBe(401)
  })

  it('rejects non-privileged roles', async () => {
    mountDefaultQueueRoom('dq-room-member', 'u1', 'member')

    const response = await fetch(`${baseUrl}/default-queue/tracks?roomId=dq-room-member&ids=a`, {
      headers: { 'x-test-user-id': 'u1' },
    })

    expect(response.status).toBe(403)
  })

  it('returns 404 for unknown rooms', async () => {
    const response = await fetch(`${baseUrl}/default-queue/tracks?roomId=nope&ids=a`, {
      headers: { 'x-test-user-id': 'u1' },
    })

    expect(response.status).toBe(404)
  })

  it('resolves refs to full tracks while keeping the stable ref id', async () => {
    const ref = makeRef('ref-1')
    mountDefaultQueueRoom('dq-room-ok', 'u2', 'admin', [ref])
    mocks.getAnyCookie.mockReturnValue(null)
    mocks.getTrackById.mockResolvedValue({
      id: 'server-generated-id',
      title: 'Full Track',
      artist: ['Test Artist'],
      album: 'Album',
      duration: 180,
      cover: '',
      source: 'netease',
      sourceId: 'source-ref-1',
      urlId: 'url-ref-1',
    })

    const response = await fetch(`${baseUrl}/default-queue/tracks?roomId=dq-room-ok&ids=ref-1`, {
      headers: { 'x-test-user-id': 'u2' },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tracks: Array<{ id: string }>; missingIds: string[] }
    expect(body.tracks).toHaveLength(1)
    expect(body.tracks[0]?.id).toBe('ref-1')
    expect(body.missingIds).toEqual([])
    expect(mocks.getTrackById).toHaveBeenCalledWith('netease', 'source-ref-1', undefined)
  })

  it('reports both unresolvable refs and ids not present in the room', async () => {
    const ref = makeRef('ref-1')
    mountDefaultQueueRoom('dq-room-missing', 'u3', 'owner', [ref])
    mocks.getAnyCookie.mockReturnValue(null)
    mocks.getTrackById.mockResolvedValue(null)

    const response = await fetch(`${baseUrl}/default-queue/tracks?roomId=dq-room-missing&ids=ref-1,ghost`, {
      headers: { 'x-test-user-id': 'u3' },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tracks: unknown[]; missingIds: string[] }
    expect(body.tracks).toEqual([])
    expect(body.missingIds).toEqual(['ref-1', 'ghost'])
  })

  it('caps a request to 50 ids', async () => {
    const refs = Array.from({ length: 60 }, (_, index) => makeRef(`ref-${index}`))
    mountDefaultQueueRoom('dq-room-cap', 'u4', 'owner', refs)
    mocks.getAnyCookie.mockReturnValue(null)
    mocks.getTrackById.mockResolvedValue({
      id: 'x',
      title: 'T',
      artist: ['A'],
      album: '',
      duration: 0,
      cover: '',
      source: 'netease',
      sourceId: 's',
      urlId: 'u',
    })

    const response = await fetch(
      `${baseUrl}/default-queue/tracks?roomId=dq-room-cap&ids=${refs.map((r) => r.id).join(',')}`,
      { headers: { 'x-test-user-id': 'u4' } },
    )

    expect(response.status).toBe(200)
    expect(mocks.getTrackById).toHaveBeenCalledTimes(50)
  })
})
