import {
  ERROR_CODE,
  EVENTS,
  defaultQueueAddBatchSchema,
  defaultQueueAddSchema,
  queueAddBatchSchema,
  queueAddSchema,
  queueInsertAfterCurrentSchema,
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
