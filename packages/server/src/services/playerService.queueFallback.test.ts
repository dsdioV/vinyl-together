import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODE, EVENTS, LIMITS } from '@music-together/shared'
import type { DefaultQueueTrackRef, Track, User } from '@music-together/shared'
import type { RoomData } from '../repositories/types.js'

const mocks = vi.hoisted(() => ({
  getStreamUrlResult: vi.fn(),
  getTrackById: vi.fn(),
  getAnyCookie: vi.fn(),
  createSystemMessage: vi.fn(),
  getFallbackTargetSource: vi.fn(),
  findBestAlternativeTrack: vi.fn(),
}))

vi.mock('./musicProvider.js', () => ({
  musicProvider: { getStreamUrlResult: mocks.getStreamUrlResult, getTrackById: mocks.getTrackById },
}))

vi.mock('./authService.js', async () => {
  const actual = await vi.importActual<typeof import('./authService.js')>('./authService.js')
  return { ...actual, getAnyCookie: mocks.getAnyCookie }
})

vi.mock('./trackFallbackService.js', () => ({
  getFallbackTargetSource: mocks.getFallbackTargetSource,
  findBestAlternativeTrack: mocks.findBestAlternativeTrack,
}))

vi.mock('./chatService.js', () => ({
  createSystemMessage: mocks.createSystemMessage,
}))

import { roomRepo } from '../repositories/roomRepository.js'
import * as playerService from './playerService.js'
import { ROOM_PLAY_LOCK_BUDGET_MS } from './playerService.js'

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

function makeRef(id: string): DefaultQueueTrackRef {
  return {
    id,
    source: 'netease',
    sourceId: `source-${id}`,
    title: `Track ${id}`,
    artist: ['Test Artist'],
  }
}

function makeRoom(user: User, defaultQueue: DefaultQueueTrackRef[] = []): RoomData {
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

/** A promise that never settles — models an upstream that accepts the request and hangs forever. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** Resolve with `value` after `ms` on the (fake) clock — models a slow but finite upstream. */
function resolvesAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}

describe('playerService.playFromDefaultQueue', () => {
  let io: { to: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAnyCookie.mockReturnValue(undefined)
    mocks.getStreamUrlResult.mockResolvedValue({ url: 'https://cdn.example/audio.mp3' })
    mocks.getTrackById.mockResolvedValue({ ...makeTrack('resolved'), id: 'resolved' })
    mocks.createSystemMessage.mockReturnValue({
      id: 'msg-1',
      userId: 'system',
      nickname: 'system',
      content: '',
      timestamp: 0,
      type: 'system',
    })
    mocks.getFallbackTargetSource.mockReturnValue('tencent')
    mocks.findBestAlternativeTrack.mockResolvedValue(null)
    const emit = vi.fn()
    io = { to: vi.fn(() => ({ emit })) }
  })

  afterEach(() => {
    roomRepo.delete('queue-fallback-room')
  })

  it('plays a random track from the default queue when the main queue is empty', async () => {
    const user: User = { id: 'user-1', nickname: 'owner', role: 'owner' }
    const room = makeRoom(user, [makeRef('default-1'), makeRef('default-2')])
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

  it('removes unresolvable default queue refs and notifies instead of stalling', async () => {
    const user: User = { id: 'user-1', nickname: 'owner', role: 'owner' }
    const room = makeRoom(user, [makeRef('dead-1')])
    roomRepo.set(room.id, room)
    mocks.getTrackById.mockResolvedValue(null)

    const ok = await playerService.playFromDefaultQueue(io as never, room.id)

    expect(ok).toBe(false)
    expect(room.defaultQueue).toHaveLength(0)
    expect(room.queue).toHaveLength(0)
    expect(room.currentTrack).toBeNull()
    expect(io.to(room.id).emit).toHaveBeenCalledWith(EVENTS.DEFAULT_QUEUE_DELTA, {
      type: 'remove',
      trackIds: ['dead-1'],
    })
    expect(io.to(room.id).emit).toHaveBeenCalledWith(EVENTS.CHAT_MESSAGE, expect.anything())
    expect(mocks.createSystemMessage).toHaveBeenCalledWith(room.id, expect.stringContaining('已无法解析'))
  })
})

// ---------------------------------------------------------------------------
// Room-lock hardening: a hung upstream must not freeze the room
//
// Regression guard for the production symptom "房间卡死、只能换房间": the whole
// stream-resolution path runs inside the per-room play mutex, so a slow upstream
// (netease measured ≈46,500 ms) used to queue every subsequent切歌/投票 behind it.
//
// The ceilings below are intentionally HARD-CODED literals rather than the
// production constant: if someone later inflates ROOM_PLAY_LOCK_BUDGET_MS, these
// tests must fail instead of silently scaling along with the regression.
// ---------------------------------------------------------------------------

/** Absolute ceiling a single play call may hold the room lock (ms). */
const LOCK_HOLD_CEILING_MS = 15_000
/** Extra fake time advanced to prove a call already settled before the ceiling. */
const SETTLE_PROBE_MS = 30_000

describe('playerService room-lock hardening (hung upstream)', () => {
  const created: string[] = []
  let io: { to: ReturnType<typeof vi.fn> }
  let emit: ReturnType<typeof vi.fn>

  function mountRoom(roomId: string, queue: Track[]): RoomData {
    const user: User = { id: 'user-1', nickname: 'owner', role: 'owner' }
    const room = makeRoom(user)
    room.id = roomId
    room.queue = queue
    // Keep the queue stable so assertions describe lock behaviour, not removal.
    room.autoRemovePlayed = false
    roomRepo.set(roomId, room)
    created.push(roomId)
    return room
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Guard the configuration itself: a future bump past the tested ceiling must
    // fail loudly here rather than silently reintroducing long lock holds.
    expect(ROOM_PLAY_LOCK_BUDGET_MS).toBeLessThanOrEqual(LOCK_HOLD_CEILING_MS)
    mocks.getAnyCookie.mockReturnValue(undefined)
    mocks.getStreamUrlResult.mockResolvedValue({ url: 'https://cdn.example/audio.mp3' })
    mocks.getTrackById.mockResolvedValue({ ...makeTrack('resolved'), id: 'resolved' })
    mocks.createSystemMessage.mockReturnValue({
      id: 'msg-1',
      userId: 'system',
      nickname: 'system',
      content: '',
      timestamp: 0,
      type: 'system',
    })
    mocks.getFallbackTargetSource.mockReturnValue('tencent')
    mocks.findBestAlternativeTrack.mockResolvedValue(null)
    emit = vi.fn()
    io = { to: vi.fn(() => ({ emit })) }
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const roomId of created.splice(0)) {
      playerService.cleanupRoom(roomId)
      roomRepo.delete(roomId)
    }
  })

  it('bounds the play call and classifies a never-settling upstream as timeout', async () => {
    const roomId = 'hung-upstream-room'
    const room = mountRoom(roomId, [{ ...makeTrack('hung') }])
    mocks.getStreamUrlResult.mockImplementation(() => neverSettles())

    const startedAt = Date.now()
    let settledAt: number | undefined
    let outcome: boolean | undefined
    const playing = playerService.playTrackInRoom(io as never, roomId, room.queue[0]!)
    void playing.then((ok) => {
      settledAt = Date.now()
      outcome = ok
    })

    // The resolver is hooked up, but the upstream never answers.
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getStreamUrlResult).toHaveBeenCalled()
    expect(outcome).toBeUndefined()

    // Advance far past the ceiling. Without the hard budget the call never
    // settles here and this assertion fails (the pre-fix behaviour).
    await vi.advanceTimersByTimeAsync(SETTLE_PROBE_MS)
    expect(outcome).toBe(false)
    expect(settledAt! - startedAt).toBeLessThanOrEqual(LOCK_HOLD_CEILING_MS)

    expect(room.currentTrack).toBeNull()
    expect(room.playState.isPlaying).toBe(false)
    expect(room.queue.find((t) => t.id === 'hung')).toBeUndefined()
    expect(emit).toHaveBeenCalledWith(
      EVENTS.ROOM_ERROR,
      expect.objectContaining({ code: ERROR_CODE.STREAM_FAILED, message: expect.stringContaining('超时') }),
    )
    expect(emit).toHaveBeenCalledWith(
      EVENTS.ROOM_AUTO_FALLBACK,
      expect.objectContaining({ status: 'failed', reasonType: 'TIMEOUT' }),
    )
  })

  it('self-heals: the room still plays the next tracks after a hung resolve', async () => {
    const roomId = 'hung-recovery-room'
    const bad = { ...makeTrack('bad') }
    const good = { ...makeTrack('good') }
    const third = { ...makeTrack('third') }
    const room = mountRoom(roomId, [bad, good, third])
    mocks.getStreamUrlResult.mockImplementation(() => neverSettles())

    const startedAt = Date.now()
    let settledAt: number | undefined
    let stuckOutcome: boolean | undefined
    const stuck = playerService.playTrackInRoom(io as never, roomId, bad)
    void stuck.then((ok) => {
      settledAt = Date.now()
      stuckOutcome = ok
    })
    await vi.advanceTimersByTimeAsync(SETTLE_PROBE_MS)
    expect(stuckOutcome).toBe(false)
    // "Room recovery time" is the lock hold time of the hung attempt.
    expect(settledAt! - startedAt).toBeLessThanOrEqual(LOCK_HOLD_CEILING_MS)

    // Upstream is healthy again. The lock must be free and the room usable with
    // no extra waiting: both a direct play and a NEXT must complete at once.
    mocks.getStreamUrlResult.mockResolvedValue({ url: 'https://cdn.example/recovered.mp3' })

    const playStartedAt = Date.now()
    await playerService.playTrackInRoom(io as never, roomId, good)
    expect(Date.now() - playStartedAt).toBe(0)
    expect(room.currentTrack?.id).toBe('good')
    expect(room.playState.isPlaying).toBe(true)
    expect(emit).toHaveBeenCalledWith(
      EVENTS.PLAYER_PLAY,
      expect.objectContaining({ track: expect.objectContaining({ id: 'good' }) }),
    )

    const nextStartedAt = Date.now()
    await playerService.playNextTrackInRoom(io as never, roomId, 'sequential', { skipDebounce: true })
    expect(Date.now() - nextStartedAt).toBe(0)
    expect(room.currentTrack?.id).toBe('third')
  })

  it('does not time out a slow upstream that still answers inside the budget', async () => {
    const roomId = 'slow-but-ok-room'
    const room = mountRoom(roomId, [])
    mocks.getStreamUrlResult.mockImplementation(() => resolvesAfter(5_000, { url: 'https://cdn.example/slow.mp3' }))

    let outcome: boolean | undefined
    const playing = playerService.playTrackInRoom(io as never, roomId, { ...makeTrack('slow-ok') })
    void playing.then((ok) => {
      outcome = ok
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(outcome).toBe(true)
    expect(room.currentTrack?.id).toBe('slow-ok')
  })

  it('shares one time budget across bitrate fallbacks instead of waiting per tier', async () => {
    const roomId = 'shared-budget-room'
    mountRoom(roomId, [])
    // 320 quality falls back through [192, 128]: three attempts × 8s = 24s if
    // each tier got its own timeout. A shared budget must cap the total instead.
    const attempts: number[] = []
    mocks.getStreamUrlResult.mockImplementation(() => {
      attempts.push(Date.now())
      return resolvesAfter(8_000, { url: null, reason: 'upstream_failed' as const })
    })

    const startedAt = Date.now()
    let settledAt: number | undefined
    let outcome: boolean | undefined
    const playing = playerService.playTrackInRoom(io as never, roomId, { ...makeTrack('slow-fail') })
    void playing.then((ok) => {
      settledAt = Date.now()
      outcome = ok
    })
    // Advance well past what the un-shared worst case would need.
    await vi.advanceTimersByTimeAsync(SETTLE_PROBE_MS)

    expect(outcome).toBe(false)
    expect(attempts.length).toBeLessThanOrEqual(2)
    expect(settledAt! - startedAt).toBeLessThanOrEqual(LOCK_HOLD_CEILING_MS)
    expect(emit).toHaveBeenCalledWith(EVENTS.ROOM_ERROR, expect.objectContaining({ code: ERROR_CODE.STREAM_FAILED }))
  })
})
