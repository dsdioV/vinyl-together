import { LIMITS, type User } from '@music-together/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { chatRepo } from '../repositories/chatRepository.js'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'
import { localAudioService } from '../services/localAudioService.js'
import { registerRoomController } from './roomController.js'

type SocketHandler = (this: TypedSocket, data?: unknown) => void

const mounted: Array<{ roomId: string; socketIds: string[] }> = []
let sequence = 0

function makeRoom(roomId: string, users: User[]): RoomData {
  const owner = users[0]
  return {
    id: roomId,
    name: roomId,
    password: null,
    creatorId: owner.id,
    hostId: owner.id,
    adminUserIds: new Set(),
    audioQuality: 128,
    users,
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
}

function mount(users: User[], mappings: Array<{ socketId: string; userId: string }>) {
  sequence += 1
  const roomId = `room-leave-local-audio-${sequence}`
  const room = makeRoom(roomId, users)
  const handlers = new Map<string, SocketHandler>()
  const socketId = mappings[0].socketId
  const socket = {
    id: socketId,
    on: vi.fn((event: string, handler: SocketHandler) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(),
    leave: vi.fn(),
    join: vi.fn(),
  } as unknown as TypedSocket
  const io = { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as TypedServer

  roomRepo.set(roomId, room)
  chatRepo.createRoom(roomId)
  for (const mapping of mappings) roomRepo.setSocketMapping(mapping.socketId, roomId, mapping.userId)
  mounted.push({ roomId, socketIds: mappings.map((mapping) => mapping.socketId) })
  registerRoomController(io, socket)

  return {
    room,
    disconnect(reason = 'transport close') {
      const handler = handlers.get('disconnect')
      if (!handler) throw new Error('disconnect handler was not registered')
      handler.call(socket, reason)
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const { roomId, socketIds } of mounted.splice(0)) {
    for (const socketId of socketIds) roomRepo.deleteSocketMapping(socketId)
    roomRepo.delete(roomId)
    chatRepo.deleteRoom(roomId)
  }
})

describe('room leave local-audio cancellation', () => {
  it('cancels request-body uploads for a genuine room departure', () => {
    const leaving: User = { id: 'leaving', nickname: 'Leaving', role: 'owner' }
    const remaining: User = { id: 'remaining', nickname: 'Remaining', role: 'member' }
    const fixture = mount(
      [leaving, remaining],
      [
        { socketId: 'leaving-socket', userId: leaving.id },
        { socketId: 'remaining-socket', userId: remaining.id },
      ],
    )
    const cancelSpy = vi.spyOn(localAudioService, 'cancelReceivingForUser').mockImplementation(() => undefined)

    fixture.disconnect()

    expect(cancelSpy).toHaveBeenCalledWith(fixture.room.id, leaving.id)
    expect(fixture.room.users.map((user) => user.id)).toEqual([remaining.id])
  })

  it('does not cancel uploads when an old socket disconnects after a replacement socket joined', () => {
    const user: User = { id: 'same-user', nickname: 'Same user', role: 'owner' }
    const fixture = mount(
      [user],
      [
        { socketId: 'old-socket', userId: user.id },
        { socketId: 'new-socket', userId: user.id },
      ],
    )
    const cancelSpy = vi.spyOn(localAudioService, 'cancelReceivingForUser').mockImplementation(() => undefined)

    fixture.disconnect()

    expect(cancelSpy).not.toHaveBeenCalled()
    expect(fixture.room.users).toEqual([user])
    expect(roomRepo.getSocketMapping('new-socket')).toMatchObject({ roomId: fixture.room.id, userId: user.id })
  })
})
