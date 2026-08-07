import { ERROR_CODE, EVENTS, LIMITS } from '@music-together/shared'
import type { DefaultQueueTrackRef, Track, User } from '@music-together/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomData } from '../repositories/types.js'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

const mocks = vi.hoisted(() => ({
  checkSocketRateLimit: vi.fn<() => Promise<boolean>>(),
  createSystemMessage: vi.fn(),
  autoPlayIfEmpty: vi.fn(),
  stopPlaybackSafe: vi.fn(),
  playFromDefaultQueue: vi.fn(),
}))

vi.mock('../middleware/socketRateLimiter.js', () => ({
  checkSocketRateLimit: mocks.checkSocketRateLimit,
}))

vi.mock('../services/chatService.js', () => ({
  createSystemMessage: mocks.createSystemMessage,
}))

vi.mock('../services/playerService.js', () => ({
  autoPlayIfEmpty: mocks.autoPlayIfEmpty,
  stopPlaybackSafe: mocks.stopPlaybackSafe,
  playFromDefaultQueue: mocks.playFromDefaultQueue,
}))

import { registerQueueController } from './queueController.js'
import { roomRepo } from '../repositories/roomRepository.js'

type SocketHandler = (this: TypedSocket, data?: unknown) => void

interface Harness {
  room: RoomData
  socket: TypedSocket
  socketEmit: ReturnType<typeof vi.fn>
  ioEmit: ReturnType<typeof vi.fn>
  handlers: Map<string, SocketHandler>
  dispatch: (event: string, data?: unknown) => Promise<void>
}

let fixtureNumber = 0
const mountedFixtures: Array<{ roomId: string; socketId: string }> = []

function makeTrack(id: string | number): Track {
  const suffix = String(id)
  return {
    id: `track-${suffix}`,
    title: `Track ${suffix}`,
    artist: ['Test Artist'],
    album: 'Test Album',
    duration: 180,
    cover: '',
    source: 'netease',
    sourceId: `source-${suffix}`,
    urlId: `url-${suffix}`,
  }
}

function makeRef(id: string | number): DefaultQueueTrackRef {
  const suffix = String(id)
  return {
    id: `track-${suffix}`,
    source: 'netease',
    sourceId: `source-${suffix}`,
    title: `Track ${suffix}`,
    artist: ['Test Artist'],
  }
}

function makeRoom(user: User, defaultQueue: DefaultQueueTrackRef[] = [], queue: Track[] = []): RoomData {
  return {
    id: `security-room-${fixtureNumber}`,
    name: 'Security Test Room',
    password: null,
    creatorId: user.id,
    hostId: user.id,
    adminUserIds: new Set(),
    audioQuality: 320,
    users: [user],
    queue,
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

function mount(role: User['role'], options?: { defaultQueue?: DefaultQueueTrackRef[]; queue?: Track[] }): Harness {
  fixtureNumber += 1
  const user: User = { id: `user-${fixtureNumber}`, nickname: role, role }
  const room = makeRoom(user, options?.defaultQueue, options?.queue)
  const roomId = room.id
  const socketId = `socket-${fixtureNumber}`
  const handlers = new Map<string, SocketHandler>()
  const socketEmit = vi.fn()
  const ioEmit = vi.fn()

  const socket = {
    id: socketId,
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: socketEmit,
  } as unknown as TypedSocket

  const io = {
    to: vi.fn(() => ({ emit: ioEmit })),
  } as unknown as TypedServer

  roomRepo.set(roomId, room)
  roomRepo.setSocketMapping(socketId, roomId, user.id)
  mountedFixtures.push({ roomId, socketId })
  registerQueueController(io, socket)

  return {
    room,
    socket,
    socketEmit,
    ioEmit,
    handlers,
    async dispatch(event, data) {
      const handler = handlers.get(event)
      if (!handler) throw new Error(`Handler was not registered for ${event}`)
      handler.call(socket, data)
      // withRoom intentionally does not return the wrapped handler promise.
      // Let its async continuation and error boundary settle before asserting.
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
  }
}

function expectNoPermission(socketEmit: ReturnType<typeof vi.fn>) {
  expect(socketEmit).toHaveBeenCalledWith(
    EVENTS.ROOM_ERROR,
    expect.objectContaining({ code: ERROR_CODE.NO_PERMISSION }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkSocketRateLimit.mockResolvedValue(true)
  mocks.createSystemMessage.mockImplementation((_roomId: string, content: string) => ({
    id: 'system-message',
    userId: 'system',
    nickname: 'system',
    content,
    timestamp: Date.now(),
    type: 'system',
  }))
  mocks.autoPlayIfEmpty.mockResolvedValue(undefined)
  mocks.stopPlaybackSafe.mockResolvedValue(undefined)
  mocks.playFromDefaultQueue.mockResolvedValue(true)
})

afterEach(() => {
  for (const { roomId, socketId } of mountedFixtures.splice(0)) {
    roomRepo.deleteSocketMapping(socketId)
    roomRepo.delete(roomId)
  }
})

describe('default queue permissions', () => {
  it('does not let a member add, batch-add, or remove default queue tracks', async () => {
    const seed = makeRef('seed')
    const fixture = mount('member', { defaultQueue: [seed] })

    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD, { track: makeTrack('single') })
    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: [makeTrack('batch')] })
    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_REMOVE, { trackId: seed.id })

    expect(fixture.room.defaultQueue).toEqual([seed])
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(fixture.socketEmit).toHaveBeenCalledTimes(3)
    expectNoPermission(fixture.socketEmit)
  })

  it.each(['admin', 'owner'] as const)('%s can add, batch-add, and remove default queue tracks', async (role) => {
    const seed = makeRef('seed')
    const fixture = mount(role, { defaultQueue: [seed] })

    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD, { track: makeTrack('single') })
    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: [makeTrack('batch')] })
    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_REMOVE, { trackId: seed.id })

    expect(fixture.room.defaultQueue.map((track) => track.id)).toEqual(['track-single', 'track-batch'])
    expect(fixture.socketEmit).not.toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.NO_PERMISSION }),
    )
    expect(mocks.checkSocketRateLimit).toHaveBeenCalledTimes(3)
  })
})

describe('queue batch limits', () => {
  it('rejects a main queue batch with an oversized playlist name', async () => {
    const fixture = mount('member')

    await fixture.dispatch(EVENTS.QUEUE_ADD_BATCH, {
      tracks: [makeTrack('named')],
      playlistName: 'x'.repeat(201),
    })

    expect(fixture.room.queue).toHaveLength(0)
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(fixture.socketEmit).toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.INVALID_DATA }),
    )
  })

  it('rejects a 1001-track main queue batch before adding anything', async () => {
    const fixture = mount('member')
    const tracks = Array.from({ length: 1_001 }, (_, index) => makeTrack(index))

    await fixture.dispatch(EVENTS.QUEUE_ADD_BATCH, { tracks })

    expect(fixture.room.queue).toHaveLength(0)
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(fixture.socketEmit).toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.INVALID_DATA }),
    )
    expect(mocks.createSystemMessage).not.toHaveBeenCalled()
  })

  it('rejects a 1001-track default queue batch before adding anything', async () => {
    const fixture = mount('admin')
    const tracks = Array.from({ length: 1_001 }, (_, index) => makeTrack(index))

    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks })

    expect(fixture.room.defaultQueue).toHaveLength(0)
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(fixture.socketEmit).toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.INVALID_DATA }),
    )
    expect(mocks.createSystemMessage).not.toHaveBeenCalled()
  })
})

describe('main queue capacity', () => {
  it('caps a legacy five-digit room setting at the current 8192 limit', async () => {
    const existing = Array.from({ length: LIMITS.QUEUE_MAX_SIZE_MAX }, (_, index) => makeTrack(index))
    const fixture = mount('member', { queue: existing })
    fixture.room.maxQueueSize = 10_000

    await fixture.dispatch(EVENTS.QUEUE_ADD, { track: makeTrack('overflow') })

    expect(fixture.room.queue).toHaveLength(LIMITS.QUEUE_MAX_SIZE_MAX)
    expect(fixture.room.queue).toEqual(existing)
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(fixture.socketEmit).toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.QUEUE_FULL }),
    )
  })
})

describe('default queue capacity', () => {
  it('does not add a single track when the default queue already has the max size', async () => {
    const existing = Array.from({ length: LIMITS.DEFAULT_QUEUE_MAX_SIZE }, (_, index) => makeRef(index))
    const fixture = mount('admin', { defaultQueue: existing })

    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD, { track: makeTrack('overflow') })

    expect(fixture.room.defaultQueue).toHaveLength(LIMITS.DEFAULT_QUEUE_MAX_SIZE)
    expect(fixture.room.defaultQueue).toEqual(existing)
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(fixture.socketEmit).toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.QUEUE_FULL }),
    )
  })

  it('adds only the remaining slot when the queue is one short of the max', async () => {
    const existing = Array.from({ length: LIMITS.DEFAULT_QUEUE_MAX_SIZE - 1 }, (_, index) => makeRef(index))
    const fixture = mount('admin', { defaultQueue: existing })

    await fixture.dispatch(EVENTS.DEFAULT_QUEUE_ADD_BATCH, {
      tracks: [makeTrack('first-new'), makeTrack('second-new')],
    })

    expect(fixture.room.defaultQueue).toHaveLength(LIMITS.DEFAULT_QUEUE_MAX_SIZE)
    expect(fixture.room.defaultQueue.at(-1)?.id).toBe('track-first-new')
    expect(fixture.room.defaultQueue.some((track) => track.id === 'track-second-new')).toBe(false)
    const deltaCall = fixture.ioEmit.mock.calls.find(([event]) => event === EVENTS.DEFAULT_QUEUE_DELTA)
    expect(deltaCall).toBeDefined()
    const delta = deltaCall?.[1] as { type: 'add'; tracks: DefaultQueueTrackRef[] }
    expect(delta.tracks).toHaveLength(1)
    expect(delta.tracks.at(-1)?.id).toBe('track-first-new')
    expect(mocks.createSystemMessage).toHaveBeenCalledWith(fixture.room.id, expect.stringContaining('添加了 1 首歌'))
  })
})

describe('default queue rate limiting', () => {
  it.each([
    [EVENTS.DEFAULT_QUEUE_ADD, { track: makeTrack('rate-single') }],
    [EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: [makeTrack('rate-batch')] }],
    [EVENTS.DEFAULT_QUEUE_REMOVE, { trackId: 'existing' }],
  ] as const)('has no side effects when rate limited: %s', async (event, payload) => {
    const existing = makeRef('existing')
    const fixture = mount('admin', { defaultQueue: [existing] })
    mocks.checkSocketRateLimit.mockResolvedValue(false)

    await fixture.dispatch(event, payload)

    expect(mocks.checkSocketRateLimit).toHaveBeenCalledTimes(1)
    expect(fixture.room.defaultQueue).toEqual([existing])
    expect(fixture.ioEmit).not.toHaveBeenCalled()
    expect(mocks.createSystemMessage).not.toHaveBeenCalled()
  })
})

describe('queue clear default queue fallback', () => {
  it('picks from the default queue after clearing when a default queue exists', async () => {
    const fixture = mount('owner', { defaultQueue: [makeRef('default-1')] })
    fixture.room.queue = [makeTrack('queued-1')]

    await fixture.dispatch(EVENTS.QUEUE_CLEAR)

    expect(fixture.room.queue).toEqual([])
    expect(mocks.stopPlaybackSafe).toHaveBeenCalledTimes(1)
    expect(mocks.playFromDefaultQueue).toHaveBeenCalledWith(expect.anything(), fixture.room.id)
    expect(fixture.ioEmit).toHaveBeenCalledWith(EVENTS.QUEUE_UPDATED, { type: 'clear' })
  })

  it('still calls the filler (no-op) when no default queue is configured', async () => {
    const fixture = mount('owner')
    fixture.room.queue = [makeTrack('queued-1')]

    await fixture.dispatch(EVENTS.QUEUE_CLEAR)

    expect(mocks.stopPlaybackSafe).toHaveBeenCalledTimes(1)
    expect(mocks.playFromDefaultQueue).toHaveBeenCalledWith(expect.anything(), fixture.room.id)
  })
})
