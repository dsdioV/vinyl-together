import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENTS, type Track } from '@music-together/shared'
import type { TypedServer } from '../middleware/types.js'
import { roomRepo } from '../repositories/roomRepository.js'
import type { RoomData } from '../repositories/types.js'

const localAudioMocks = vi.hoisted(() => ({
  refreshTrack: vi.fn(),
}))

vi.mock('./localAudioService.js', () => ({
  localAudioService: localAudioMocks,
}))

vi.mock('./roomLifecycleService.js', () => ({
  broadcastRoomList: vi.fn(),
}))

import { cleanupRoom, playNextTrackInRoom, resumeTrack } from './playerService.js'

const roomIds: string[] = []

function localTrack(id = 'local-track'): Track {
  return {
    id,
    title: 'Local track',
    artist: ['Uploader'],
    album: 'Local',
    duration: 10,
    cover: '',
    source: 'local',
    sourceId: 'asset-1',
    urlId: 'asset-1',
    assetId: 'asset-1',
    streamUrl: '/local/asset-1',
  }
}

function mountRoom(track: Track, playMode: RoomData['playMode']): RoomData {
  const roomId = `player-local-${roomIds.length + 1}`
  const owner = { id: 'owner', nickname: 'owner', role: 'owner' as const }
  const room: RoomData = {
    id: roomId,
    name: roomId,
    password: null,
    creatorId: owner.id,
    hostId: owner.id,
    adminUserIds: new Set(),
    audioQuality: 128,
    users: [owner],
    queue: [track],
    defaultQueue: [],
    currentTrack: track,
    playState: { isPlaying: true, currentTime: 9, serverTimestamp: Date.now() },
    playMode,
    autoRemovePlayed: false,
    songLikes: false,
    persistent: false,
    persistentTtlHours: 0,
    trackLikes: new Map(),
    trackLikeTimestamps: new Map(),
    voteThreshold: 0.67,
    maxQueueSize: 200,
    playedHistory: [],
  }
  roomRepo.set(roomId, room)
  roomIds.push(roomId)
  return room
}

afterEach(() => {
  localAudioMocks.refreshTrack.mockReset()
  for (const roomId of roomIds.splice(0)) {
    cleanupRoom(roomId)
    roomRepo.delete(roomId)
  }
})

describe('playerService pending local audio', () => {
  it('broadcasts the freshly signed local track when playback resumes', async () => {
    const track = localTrack('resumed-track')
    const room = mountRoom(track, 'sequential')
    room.playState = { isPlaying: false, currentTime: 4, serverTimestamp: Date.now() }
    const refreshed = {
      ...track,
      streamUrl: '/local/asset-1?token=fresh',
      localAudioAccessExpiresAt: Date.now() + 86_400_000,
    }
    localAudioMocks.refreshTrack.mockReturnValue(refreshed)
    const emit = vi.fn()
    const io = { to: vi.fn(() => ({ emit })) } as unknown as TypedServer

    await resumeTrack(io, room.id)

    expect(room.currentTrack).toEqual(refreshed)
    expect(emit).toHaveBeenCalledWith(
      EVENTS.PLAYER_RESUME,
      expect.objectContaining({
        track: refreshed,
        playState: expect.objectContaining({ isPlaying: true, currentTime: 4 }),
      }),
    )
  })

  it('does not let a delayed local resume overwrite a newer playback action', async () => {
    const track = localTrack('stale-resume-track')
    const room = mountRoom(track, 'sequential')
    room.playState = { isPlaying: false, currentTime: 4, serverTimestamp: Date.now() }
    let releaseRefresh!: () => void
    const refreshed = { ...track, streamUrl: '/local/asset-1?token=fresh' }
    localAudioMocks.refreshTrack.mockReturnValue(
      new Promise<Track>((resolve) => {
        releaseRefresh = () => resolve(refreshed)
      }),
    )
    const emit = vi.fn()
    const io = { to: vi.fn(() => ({ emit })) } as unknown as TypedServer

    const resuming = resumeTrack(io, room.id)
    await vi.waitFor(() => expect(localAudioMocks.refreshTrack).toHaveBeenCalled())

    const newerTrack = { ...localTrack('newer-track'), sourceId: 'asset-2', urlId: 'asset-2', assetId: 'asset-2' }
    const newerPlayState = { isPlaying: true, currentTime: 0, serverTimestamp: Date.now() + 1 }
    room.currentTrack = newerTrack
    room.playState = newerPlayState
    releaseRefresh()
    await resuming

    expect(room.currentTrack).toBe(newerTrack)
    expect(room.playState).toBe(newerPlayState)
    expect(emit).not.toHaveBeenCalledWith(EVENTS.PLAYER_RESUME, expect.anything())
  })

  it.each(['loop-one', 'loop-all'] as const)(
    'stops playback when a pending-delete local track is the only %s candidate',
    async (playMode) => {
      const track = localTrack(`${playMode}-track`)
      const room = mountRoom(track, playMode)
      localAudioMocks.refreshTrack.mockReturnValue(null)
      const emit = vi.fn()
      const io = { to: vi.fn(() => ({ emit })) } as unknown as TypedServer

      await playNextTrackInRoom(io, room.id, playMode, { skipDebounce: true })

      expect(room.queue).toEqual([])
      expect(room.currentTrack).toBeNull()
      expect(room.playState.isPlaying).toBe(false)
      expect(emit).toHaveBeenCalledWith(EVENTS.PLAYER_PAUSE, expect.any(Object))
    },
  )

  it('stops the removed current track before waiting for the next local stream to resolve', async () => {
    const removed = localTrack('removed-track')
    const next = {
      ...localTrack('next-track'),
      sourceId: 'asset-2',
      urlId: 'asset-2',
      assetId: 'asset-2',
      streamUrl: '/local/asset-2',
    }
    const room = mountRoom(removed, 'sequential')
    room.queue = [next]
    let release!: () => void
    const resolved = new Promise<Track>((resolve) => {
      release = () => resolve(next)
    })
    localAudioMocks.refreshTrack.mockReturnValue(resolved)
    const emit = vi.fn()
    const io = { to: vi.fn(() => ({ emit })) } as unknown as TypedServer

    const advancing = playNextTrackInRoom(io, room.id, room.playMode, {
      skipDebounce: true,
      previousIndex: 0,
      currentAlreadyRemoved: true,
      skipHistory: true,
      stopBeforeResolve: true,
    })
    await vi.waitFor(() => expect(localAudioMocks.refreshTrack).toHaveBeenCalled())

    expect(room.currentTrack).toBeNull()
    expect(room.playState.isPlaying).toBe(false)
    expect(emit).toHaveBeenCalledWith(EVENTS.PLAYER_PAUSE, expect.any(Object))
    expect(emit).toHaveBeenCalledWith(EVENTS.ROOM_STATE, expect.objectContaining({ currentTrack: null }))
    expect(emit).not.toHaveBeenCalledWith(EVENTS.PLAYER_PLAY, expect.any(Object))

    release()
    await advancing
    expect(room.currentTrack?.id).toBe(next.id)
    expect(emit).toHaveBeenCalledWith(
      EVENTS.PLAYER_PLAY,
      expect.objectContaining({ track: expect.objectContaining({ id: next.id }) }),
    )
  })

  it('leaves playback stopped if resolving the next track throws', async () => {
    const removed = localTrack('removed-track')
    const next = {
      ...localTrack('next-track'),
      sourceId: 'asset-2',
      urlId: 'asset-2',
      assetId: 'asset-2',
      streamUrl: '/local/asset-2',
    }
    const room = mountRoom(removed, 'sequential')
    room.queue = [next]
    localAudioMocks.refreshTrack.mockRejectedValue(new Error('refresh failed'))
    const emit = vi.fn()
    const io = { to: vi.fn(() => ({ emit })) } as unknown as TypedServer

    await expect(
      playNextTrackInRoom(io, room.id, room.playMode, {
        skipDebounce: true,
        previousIndex: 0,
        currentAlreadyRemoved: true,
        skipHistory: true,
        stopBeforeResolve: true,
      }),
    ).rejects.toThrow('refresh failed')

    expect(room.currentTrack).toBeNull()
    expect(room.playState.isPlaying).toBe(false)
    expect(emit).toHaveBeenCalledWith(EVENTS.PLAYER_PAUSE, expect.any(Object))
  })
})
