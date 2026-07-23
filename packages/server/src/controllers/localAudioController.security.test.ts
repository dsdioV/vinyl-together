import { EVENTS, LIMITS, type User } from '@music-together/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'

const mocks = vi.hoisted(() => ({
  checkSocketRateLimit: vi.fn<() => Promise<boolean>>(),
  emitSnapshot: vi.fn(),
  updateAsset: vi.fn(),
}))

vi.mock('../middleware/socketRateLimiter.js', () => ({
  checkSocketRateLimit: mocks.checkSocketRateLimit,
}))

vi.mock('../services/localAudioService.js', () => ({
  localAudioService: {
    emitSnapshot: mocks.emitSnapshot,
    cancelTask: vi.fn(),
    updateAsset: mocks.updateAsset,
    deleteAsset: vi.fn(),
  },
  localAudioErrorPayload: vi.fn(() => ({ code: 'LOCAL_AUDIO_INVALID', message: 'invalid' })),
}))

import { registerLocalAudioController } from './localAudioController.js'

type SocketHandler = (this: TypedSocket, data?: unknown) => void

const mounted: Array<{ roomId: string; socketId: string }> = []
let sequence = 0

function mount(): { dispatch: (event: string, data?: unknown) => Promise<void> } {
  sequence += 1
  const roomId = `local-audio-security-${sequence}`
  const socketId = `local-audio-socket-${sequence}`
  const user: User = { id: `user-${sequence}`, nickname: 'member', role: 'member' }
  const room: RoomData = {
    id: roomId,
    name: roomId,
    password: null,
    creatorId: user.id,
    hostId: user.id,
    adminUserIds: new Set(),
    audioQuality: 128,
    users: [user],
    queue: [],
    defaultQueue: [],
    currentTrack: null,
    playState: { isPlaying: false, currentTime: 0, serverTimestamp: Date.now() },
    playMode: 'sequential',
    autoRemovePlayed: false,
    songLikes: false,
    persistent: false,
    persistentTtlHours: 0,
    trackLikes: new Map(),
    trackLikeTimestamps: new Map(),
    voteThreshold: 0.67,
    maxQueueSize: LIMITS.QUEUE_MAX_SIZE_DEFAULT,
    playedHistory: [],
  }
  const handlers = new Map<string, SocketHandler>()
  const socket = {
    id: socketId,
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(),
  } as unknown as TypedSocket
  const io = { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as TypedServer

  roomRepo.set(roomId, room)
  roomRepo.setSocketMapping(socketId, roomId, user.id)
  mounted.push({ roomId, socketId })
  registerLocalAudioController(io, socket)

  return {
    async dispatch(event, data) {
      const handler = handlers.get(event)
      if (!handler) throw new Error(`Handler was not registered for ${event}`)
      handler.call(socket, data)
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkSocketRateLimit.mockResolvedValue(true)
})

afterEach(() => {
  for (const { roomId, socketId } of mounted.splice(0)) {
    roomRepo.deleteSocketMapping(socketId)
    roomRepo.delete(roomId)
  }
})

describe('local audio socket rate limiting', () => {
  it('does not emit a snapshot when the socket is rate limited', async () => {
    const fixture = mount()
    mocks.checkSocketRateLimit.mockResolvedValue(false)

    await fixture.dispatch(EVENTS.LOCAL_AUDIO_STATE_REQUEST)

    expect(mocks.checkSocketRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.emitSnapshot).not.toHaveBeenCalled()
  })

  it('does not mutate or broadcast metadata when the socket is rate limited', async () => {
    const fixture = mount()
    mocks.checkSocketRateLimit.mockResolvedValue(false)

    await fixture.dispatch(EVENTS.LOCAL_AUDIO_ASSET_UPDATE, {
      assetId: 'asset-1',
      title: 'Updated title',
      artist: ['Updated artist'],
      album: 'Updated album',
    })

    expect(mocks.checkSocketRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.updateAsset).not.toHaveBeenCalled()
  })
})
