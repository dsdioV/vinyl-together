import {
  ERROR_CODE,
  EVENTS,
  defaultQueueAddBatchSchema,
  defaultQueueAddSchema,
  queueAddBatchSchema,
  queueAddSchema,
  queueInsertAfterCurrentSchema,
  sanitizeCoverProxyUrl,
} from '@music-together/shared'
import type { Track, User } from '@music-together/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomData } from '../repositories/types.js'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

const playerMocks = vi.hoisted(() => ({
  playTrackInRoom: vi.fn(),
  resumeTrack: vi.fn(),
}))

vi.mock('../services/playerService.js', () => playerMocks)
vi.mock('../middleware/socketRateLimiter.js', () => ({
  checkSocketRateLimit: vi.fn().mockResolvedValue(true),
}))

import { registerPlayerController } from './playerController.js'
import { roomRepo } from '../repositories/roomRepository.js'

const untrustedTrack = {
  id: 'track-1',
  title: 'Test Track',
  artist: ['Test Artist'],
  album: 'Test Album',
  duration: 180,
  cover: '',
  source: 'netease' as const,
  sourceId: 'source-1',
  urlId: 'url-1',
  streamUrl: 'https://attacker.invalid/track.mp3',
}

describe('client track schemas', () => {
  it.each([
    ['queue add', queueAddSchema],
    ['queue insert', queueInsertAfterCurrentSchema],
    ['default queue add', defaultQueueAddSchema],
  ])('strips an untrusted streamUrl from %s payloads', (_name, schema) => {
    const parsed = schema.parse({ track: untrustedTrack })

    expect(parsed.track).not.toHaveProperty('streamUrl')
  })

  it.each([
    ['queue batch add', queueAddBatchSchema],
    ['default queue batch add', defaultQueueAddBatchSchema],
  ])('strips untrusted streamUrl values from %s payloads', (_name, schema) => {
    const parsed = schema.parse({ tracks: [untrustedTrack] })

    expect(parsed.tracks[0]).not.toHaveProperty('streamUrl')
  })

  it.each([
    ['netease', 'https://p1.music.126.net/image.jpg?param=300y300', 'https://p1.music.126.net/image.jpg?param=300y300'],
    ['netease', 'http://p4.music.126.net/image.jpg', 'https://p4.music.126.net/image.jpg'],
    ['tencent', 'https://y.gtimg.cn/music/photo_new/cover.jpg', 'https://y.gtimg.cn/music/photo_new/cover.jpg'],
    [
      'kugou',
      'http://imge.kugou.com/stdmusic/400/cover.jpg?x=1#fragment',
      'https://imge.kugou.com/stdmusic/400/cover.jpg?x=1',
    ],
    ['kugou', 'https://imgessl.kugou.com/stdmusic/cover.jpg', 'https://imgessl.kugou.com/stdmusic/cover.jpg'],
  ] as const)('preserves a trusted %s cover and normalizes it to HTTPS', (source, cover, expected) => {
    const parsed = queueAddSchema.parse({ track: { ...untrustedTrack, source, cover } })

    expect(parsed.track.cover).toBe(expected)
  })

  it.each([
    ['tracking pixel', 'netease', 'https://attacker.example/pixel.gif'],
    ['loopback host', 'netease', 'http://127.0.0.1/internal'],
    ['private host', 'netease', 'http://192.168.1.1/internal'],
    ['data URL', 'netease', 'data:image/png;base64,AAAA'],
    ['protocol-relative URL', 'tencent', '//y.gtimg.cn/cover.jpg'],
    ['forged suffix', 'tencent', 'https://y.gtimg.cn.evil.example/cover.jpg'],
    ['userinfo', 'tencent', 'https://attacker.example@y.gtimg.cn/cover.jpg'],
    ['custom port', 'tencent', 'https://y.gtimg.cn:444/cover.jpg'],
    ['source mismatch', 'netease', 'https://y.gtimg.cn/cover.jpg'],
  ] as const)('clears an untrusted cover (%s)', (_name, source, cover) => {
    const parsed = queueAddSchema.parse({ track: { ...untrustedTrack, source, cover } })

    expect(parsed.track.cover).toBe('')
  })

  it('applies cover sanitization to batch and default-queue schemas', () => {
    const malicious = { ...untrustedTrack, cover: 'https://attacker.example/pixel.gif' }

    expect(queueAddBatchSchema.parse({ tracks: [malicious] }).tracks[0].cover).toBe('')
    expect(defaultQueueAddSchema.parse({ track: malicious }).track.cover).toBe('')
    expect(defaultQueueAddBatchSchema.parse({ tracks: [malicious] }).tracks[0].cover).toBe('')
    expect(queueInsertAfterCurrentSchema.parse({ track: malicious }).track.cover).toBe('')
  })

  it('uses the same URL policy for the public cover proxy', () => {
    expect(sanitizeCoverProxyUrl('http://imge.kugou.com/stdmusic/cover.jpg')).toBe(
      'https://imge.kugou.com/stdmusic/cover.jpg',
    )
    expect(sanitizeCoverProxyUrl('https://127.0.0.1/cover.jpg')).toBe('')
    expect(sanitizeCoverProxyUrl('https://y.gtimg.cn.evil.example/cover.jpg')).toBe('')
  })
})

describe('PLAYER_PLAY track boundary', () => {
  const roomId = 'room-1'
  const socketId = 'socket-1'
  const user: User = { id: 'user-1', nickname: 'Owner', role: 'owner' }
  const handlers = new Map<string, (this: TypedSocket, data?: unknown) => void>()
  const socket = {
    id: socketId,
    on: vi.fn((event: string, handler: (this: TypedSocket, data?: unknown) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(),
  } as unknown as TypedSocket
  const io = {} as TypedServer

  const trustedTrack: Track = {
    ...untrustedTrack,
    id: 'trusted-track',
    streamUrl: 'https://server.example/trusted.mp3',
  }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()

    const room: RoomData = {
      id: roomId,
      name: 'Test Room',
      password: null,
      creatorId: user.id,
      hostId: user.id,
      adminUserIds: new Set(),
      audioQuality: 320,
      users: [user],
      queue: [trustedTrack],
      defaultQueue: [],
      currentTrack: null,
      playState: { isPlaying: false, currentTime: 0, serverTimestamp: Date.now() },
      playMode: 'sequential',
      autoRemovePlayed: true,
      songLikes: true,
      persistent: false,
      persistentTtlHours: 0,
      trackLikes: new Map(),
      trackLikeTimestamps: new Map(),
      voteThreshold: 0.67,
      maxQueueSize: 1000,
      playedHistory: [],
    }

    roomRepo.set(roomId, room)
    roomRepo.setSocketMapping(socketId, roomId, user.id)
    registerPlayerController(io, socket)
  })

  afterEach(() => {
    roomRepo.deleteSocketMapping(socketId)
    roomRepo.delete(roomId)
  })

  async function dispatchPlay(data?: unknown): Promise<void> {
    const handler = handlers.get(EVENTS.PLAYER_PLAY)
    if (!handler) throw new Error('PLAYER_PLAY handler was not registered')
    handler.call(socket, data)
    await vi.waitFor(() =>
      expect(
        playerMocks.playTrackInRoom.mock.calls.length +
          playerMocks.resumeTrack.mock.calls.length +
          socket.emit.mock.calls.length,
      ).toBeGreaterThan(0),
    )
  }

  it('uses only the ID from a legacy client-supplied Track object', async () => {
    await dispatchPlay({ track: { ...untrustedTrack, id: trustedTrack.id } })

    expect(playerMocks.playTrackInRoom).toHaveBeenCalledWith(io, roomId, trustedTrack)
    expect(playerMocks.playTrackInRoom).not.toHaveBeenCalledWith(
      io,
      roomId,
      expect.objectContaining({
        streamUrl: untrustedTrack.streamUrl,
      }),
    )
  })

  it('rejects a play payload without a supported track identifier', async () => {
    await dispatchPlay({ streamUrl: untrustedTrack.streamUrl })

    expect(playerMocks.playTrackInRoom).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith(EVENTS.ROOM_ERROR, {
      code: ERROR_CODE.INVALID_DATA,
      message: '无效的播放请求',
    })
  })

  it('resolves a requested trackId from the server-side room queue', async () => {
    await dispatchPlay({ trackId: trustedTrack.id })

    expect(playerMocks.playTrackInRoom).toHaveBeenCalledWith(io, roomId, trustedTrack)
  })

  it('preserves no-payload resume for the server-side current track', async () => {
    const room = roomRepo.get(roomId)
    if (!room) throw new Error('Test room was not created')
    room.currentTrack = trustedTrack

    await dispatchPlay()

    expect(playerMocks.resumeTrack).toHaveBeenCalledWith(io, roomId, socket)
    expect(playerMocks.playTrackInRoom).not.toHaveBeenCalled()
  })

  it('rejects a trackId that is not in the room queue', async () => {
    await dispatchPlay({ trackId: 'missing-track' })

    expect(playerMocks.playTrackInRoom).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith(EVENTS.ROOM_ERROR, {
      code: ERROR_CODE.INVALID_DATA,
      message: '歌曲不在播放列表中',
    })
  })
})
