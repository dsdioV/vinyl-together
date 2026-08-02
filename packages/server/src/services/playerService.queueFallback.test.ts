import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENTS, LIMITS } from '@music-together/shared'
import type { Track, User } from '@music-together/shared'
import type { RoomData } from '../repositories/types.js'

const mocks = vi.hoisted(() => ({
  getStreamUrlResult: vi.fn(),
  getAnyCookie: vi.fn(),
}))

vi.mock('./musicProvider.js', () => ({
  musicProvider: { getStreamUrlResult: mocks.getStreamUrlResult },
}))

vi.mock('./authService.js', async () => {
  const actual = await vi.importActual<typeof import('./authService.js')>('./authService.js')
  return { ...actual, getAnyCookie: mocks.getAnyCookie }
})

vi.mock('./trackFallbackService.js', () => ({}))

import { roomRepo } from '../repositories/roomRepository.js'
import * as playerService from './playerService.js'

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: ['Test Artist'],
    album: 'Test Album',
    duration: 180,
    cover: '',
    source: 'netease',
    sourceId: `source-${id}`,
    urlId: `url-${id}`,
  }
}

function makeRoom(user: User, defaultQueue: Track[] = []): RoomData {
  return {
    id: 'queue-fallback-room',
    name: 'Queue Fallback Test Room',
    password: null,
    creatorId: user.id,
    hostId: user.id,
    adminUserIds: new Set(),
    audioQuality: 320,
    users: [user],
    queue: [],
    defaultQueue,
    currentTrack: null,
    playState: { isPlaying: false, currentTime: 0, serverTimestamp: Date.now() },
    playMode: 'sequential',
    autoRemovePlayed: true,
    songLikes: false,
    persistent: false,
    persistentTtlHours: 0,
    trackLikes: new Map(),
    trackLikeTimestamps: new Map(),
    voteThreshold: 0.67,
    maxQueueSize: LIMITS.QUEUE_MAX_SIZE_MAX,
    playedHistory: [],
  }
}

describe('playerService.playFromDefaultQueue', () => {
  let io: { to: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAnyCookie.mockReturnValue(undefined)
    mocks.getStreamUrlResult.mockResolvedValue({ url: 'https://cdn.example/audio.mp3' })
    const emit = vi.fn()
    io = { to: vi.fn(() => ({ emit })) }
  })

  afterEach(() => {
    roomRepo.delete('queue-fallback-room')
  })

  it('plays a random track from the default queue when the main queue is empty', async () => {
    const user: User = { id: 'user-1', nickname: 'owner', role: 'owner' }
    const room = makeRoom(user, [makeTrack('default-1'), makeTrack('default-2')])
    roomRepo.set(room.id, room)

    const ok = await playerService.playFromDefaultQueue(io as never, room.id)

    expect(ok).toBe(true)
    expect(room.queue).toHaveLength(1)
    expect(['default-1', 'default-2']).toContain(room.queue[0]!.id)
    expect(room.currentTrack?.id).toBe(room.queue[0]!.id)
    expect(io.to).toHaveBeenCalledWith(room.id)
    expect(io.to(room.id).emit).toHaveBeenCalledWith(EVENTS.QUEUE_UPDATED, expect.objectContaining({ type: 'insert' }))
  })

  it('returns false without changing the queue when the default queue is empty', async () => {
    const user: User = { id: 'user-1', nickname: 'owner', role: 'owner' }
    const room = makeRoom(user)
    roomRepo.set(room.id, room)

    const ok = await playerService.playFromDefaultQueue(io as never, room.id)

    expect(ok).toBe(false)
    expect(room.queue).toHaveLength(0)
    expect(room.currentTrack).toBeNull()
    expect(io.to).not.toHaveBeenCalled()
  })
})
