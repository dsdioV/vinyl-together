import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ERROR_CODE,
  EVENTS,
  type AudioQuality,
  type DefaultQueueTrackRef,
  type Track,
  type User,
} from '@music-together/shared'
import type { TypedServer } from '../middleware/types.js'
import type { RoomData } from '../repositories/types.js'
import { roomRepo } from '../repositories/roomRepository.js'
import { chatRepo } from '../repositories/chatRepository.js'
import { LocalAudioService, type LocalAudioTaskActor } from './localAudioService.js'
import { LOCAL_AUDIO_MEDIA_LIMITS, type LocalAudioMedia, type LocalAudioMetadata } from './localAudioMedia.js'

/** Keep deletion assertions independent from playback/network implementation. */
const playerMocks = vi.hoisted(() => ({
  autoPlayIfEmpty: vi.fn(async () => true),
  playNextTrackInRoom: vi.fn(async () => undefined),
}))

vi.mock('./playerService.js', () => playerMocks)

const roomIds: string[] = []
const services: LocalAudioService[] = []
let sequence = 0

const actor = (id: string, role: User['role'] = 'member'): LocalAudioTaskActor => ({
  id,
  nickname: id,
  role,
})

function room(
  roomId: string,
  users: User[] = [actor('owner', 'owner') as User],
  audioQuality: AudioQuality = 128,
): RoomData {
  const owner = users.find((user) => user.role === 'owner') ?? users[0]
  return {
    id: roomId,
    name: roomId,
    password: null,
    creatorId: owner.id,
    hostId: owner.id,
    adminUserIds: new Set(users.filter((user) => user.role === 'admin').map((user) => user.id)),
    audioQuality,
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
    maxQueueSize: 200,
    playedHistory: [],
  }
}

function mountRoom(users: User[] = [actor('owner', 'owner') as User], audioQuality: AudioQuality = 128): string {
  const roomId = `local-audio-test-${++sequence}`
  roomIds.push(roomId)
  const data = room(roomId, users, audioQuality)
  roomRepo.set(roomId, data)
  chatRepo.createRoom(roomId)
  return roomId
}

async function makeService(
  options: ConstructorParameters<typeof LocalAudioService>[0] = {},
): Promise<LocalAudioService> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vinyl-local-audio-'))
  const service = new LocalAudioService({
    dataDir,
    minFreeBytes: 0,
    ...options,
  })
  services.push(service)
  return service
}

function metadata(overrides: Partial<LocalAudioMetadata> = {}): LocalAudioMetadata {
  return {
    title: 'Fake title',
    artist: ['Fake artist'],
    album: 'Fake album',
    durationSeconds: 1,
    bitrateKbps: 128,
    sampleRate: 44_100,
    channels: 2,
    sizeBytes: 1,
    container: 'mp3',
    codec: 'mp3',
    format: 'mp3',
    lossless: false,
    hasEmbeddedCover: false,
    ...overrides,
  }
}

interface FakeMediaOptions {
  outputBytes?: number
  coverBytes?: number
  probe?: (request: { signal?: AbortSignal }) => Promise<LocalAudioMetadata>
  onTranscode?: (outputPath: string) => Promise<void>
  onTranscodeRequest?: (request: { outputPath: string; maxOutputBytes?: number }) => Promise<void>
  onExtractCoverRequest?: (request: { outputPath: string; maxBytes?: number }) => Promise<void>
}

/**
 * Service tests use the real output paths but replace ffprobe/ffmpeg with this
 * tiny injected boundary. That exercises reservations and cleanup without a
 * machine-installed FFmpeg binary.
 */
function fakeMedia(options: FakeMediaOptions = {}): LocalAudioMedia {
  const outputBytes = options.outputBytes ?? 32
  return {
    probeFile: vi.fn(async (request: { signal?: AbortSignal }) => {
      if (request.signal?.aborted) throw new Error('ABORTED')
      return options.probe ? options.probe(request) : metadata()
    }),
    transcode: vi.fn(async (request: { outputPath: string; signal?: AbortSignal }) => {
      if (request.signal?.aborted) throw new Error('ABORTED')
      await writeFile(request.outputPath, Buffer.alloc(outputBytes, 0x5a))
      await options.onTranscode?.(request.outputPath)
      await options.onTranscodeRequest?.(request)
    }),
    extractCover: vi.fn(async (request: { outputPath: string }) => {
      await options.onExtractCoverRequest?.(request)
      if (options.coverBytes === undefined) return { path: null, sizeBytes: 0, reason: 'missing' as const }
      await writeFile(request.outputPath, Buffer.alloc(options.coverBytes, 0x43))
      return { path: request.outputPath, sizeBytes: options.coverBytes }
    }),
  } as unknown as LocalAudioMedia
}

function body(size: number, value = 0x61): Readable {
  return Readable.from([Buffer.alloc(size, value)])
}

async function upload(
  service: LocalAudioService,
  roomId: string,
  uploader: LocalAudioTaskActor,
  size = 8,
  addToQueue = false,
): Promise<string> {
  const task = await service.createTask(roomId, uploader, {
    fileName: `${uploader.id}.mp3`,
    fileSize: size,
    addToQueue,
  })
  await service.receiveUpload({
    taskId: task.taskId,
    roomId,
    actor: uploader,
    request: body(size),
    contentLength: size,
  })
  return task.taskId
}

async function waitForTask(
  service: LocalAudioService,
  roomId: string,
  taskId: string,
  stage: 'ready' | 'failed' | 'cancelled',
): Promise<ReturnType<LocalAudioService['snapshot']>['tasks'][number]> {
  await vi.waitFor(
    () => {
      const task = service.snapshot(roomId).tasks.find((item) => item.taskId === taskId)
      expect(task?.stage).toBe(stage)
    },
    { timeout: 3000, interval: 10 },
  )
  return service.snapshot(roomId).tasks.find((item) => item.taskId === taskId)!
}

async function assetFor(
  service: LocalAudioService,
  roomId: string,
  uploader = actor('owner', 'owner'),
): Promise<{ taskId: string; assetId: string }> {
  const taskId = await upload(service, roomId, uploader)
  const task = await waitForTask(service, roomId, taskId, 'ready')
  expect(task.assetId).toBeTruthy()
  return { taskId, assetId: task.assetId! }
}

beforeEach(() => {
  playerMocks.autoPlayIfEmpty.mockClear()
  playerMocks.playNextTrackInRoom.mockClear()
})

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.shutdown().catch(() => undefined)
    await rm(service.dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  for (const roomId of roomIds.splice(0)) {
    roomRepo.deleteSocketMapping(`socket-${roomId}`)
    roomRepo.delete(roomId)
    chatRepo.deleteRoom(roomId)
  }
})

describe('LocalAudioService upload limits and reservations', () => {
  it('rejects new task creation and request-body uploads after shutdown draining begins', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const existing = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'existing.mp3',
      fileSize: 5,
      addToQueue: false,
    })

    service.beginShutdown()

    await expect(
      service.createTask(roomId, actor('owner', 'owner'), {
        fileName: 'late.mp3',
        fileSize: 5,
        addToQueue: false,
      }),
    ).rejects.toThrow('LOCAL_AUDIO_SHUTTING_DOWN')
    await expect(
      service.receiveUpload({
        taskId: existing.taskId,
        roomId,
        actor: actor('owner', 'owner'),
        request: body(5),
        contentLength: 5,
      }),
    ).rejects.toThrow('LOCAL_AUDIO_SHUTTING_DOWN')
    expect(service.snapshot(roomId).tasks).toHaveLength(1)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(5)
  })

  it('does not commit a task whose disk preflight overlaps shutdown draining', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    await service.initialize()
    const roomId = mountRoom([actor('owner', 'owner') as User])
    let reached!: () => void
    const preflightReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    let release!: () => void
    const preflightRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    vi.spyOn(internals, 'freeBytes').mockImplementationOnce(async () => {
      reached()
      await preflightRelease
      return Number.MAX_SAFE_INTEGER
    })

    const creating = service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'racing.mp3',
      fileSize: 5,
      addToQueue: false,
    })
    await preflightReached
    service.beginShutdown()
    release()

    await expect(creating).rejects.toThrow('LOCAL_AUDIO_SHUTTING_DOWN')
    expect(service.snapshot(roomId).tasks).toHaveLength(0)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
  })

  it('removes stale temporary and asset files when storage initializes', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vinyl-local-audio-stale-'))
    const staleAssetDir = path.join(dataDir, 'assets', 'old-room', 'old-asset')
    const staleTempDir = path.join(dataDir, 'tmp')
    await mkdir(staleAssetDir, { recursive: true })
    await mkdir(staleTempDir, { recursive: true })
    await writeFile(path.join(staleAssetDir, 'primary.mp3'), Buffer.from('stale'))
    await writeFile(path.join(staleTempDir, 'stale.part'), Buffer.from('stale'))
    const service = new LocalAudioService({ dataDir, minFreeBytes: 0 })
    services.push(service)

    await service.initialize()
    expect(await readdir(service.assetsDir)).toEqual([])
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('rejects an oversized single file before reserving temporary space', async () => {
    const service = await makeService({ maxUploadBytes: 10, tempQuotaBytes: 100 })
    const roomId = mountRoom([actor('owner', 'owner') as User])

    await expect(
      service.createTask(roomId, actor('owner', 'owner'), {
        fileName: 'too-large.mp3',
        fileSize: 11,
        addToQueue: false,
      }),
    ).rejects.toThrow('LOCAL_AUDIO_INVALID_SIZE')
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
  })

  it('enforces the temporary reservation quota across rooms', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 100 })
    const userA = actor('a') as User
    const userB = actor('b') as User
    const roomA = mountRoom([userA])
    const roomB = mountRoom([userB])

    await service.createTask(roomA, actor('a'), { fileName: 'a.mp3', fileSize: 80, addToQueue: false })
    await expect(
      service.createTask(roomB, actor('b'), { fileName: 'b.mp3', fileSize: 21, addToQueue: false }),
    ).rejects.toThrow('LOCAL_AUDIO_QUOTA_EXCEEDED')
    expect(service.snapshot(roomA).usage.tempBytes).toBe(80)
    expect(service.snapshot(roomB).usage.tempBytes).toBe(80)
  })

  it('rejects creation when the configured disk reserve would be consumed', async () => {
    const service = await makeService({ minFreeBytes: Number.MAX_SAFE_INTEGER })
    const roomId = mountRoom([actor('owner', 'owner') as User])

    await expect(
      service.createTask(roomId, actor('owner', 'owner'), {
        fileName: 'disk.mp3',
        fileSize: 1,
        addToQueue: false,
      }),
    ).rejects.toThrow('LOCAL_AUDIO_DISK_LOW')
  })

  it('enforces one active upload pipeline per user across all rooms', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const user = actor('same-user') as User
    const roomA = mountRoom([user])
    const roomB = mountRoom([user])
    const task = await service.createTask(roomA, actor('same-user'), {
      fileName: 'a.mp3',
      fileSize: 10,
      addToQueue: false,
    })

    await expect(
      service.createTask(roomB, actor('same-user'), { fileName: 'b.mp3', fileSize: 10, addToQueue: false }),
    ).rejects.toThrow('LOCAL_AUDIO_BUSY')
    expect(await service.cancelTask(roomA, task.taskId, actor('same-user'))).toBe(true)
    await expect(
      service.createTask(roomB, actor('same-user'), { fileName: 'b.mp3', fileSize: 10, addToQueue: false }),
    ).resolves.toMatchObject({
      stage: 'waiting-upload',
    })
  })

  it('enforces final room quota and releases failed reservations', async () => {
    const service = await makeService({
      media: fakeMedia({ outputBytes: 700_000 }),
      roomQuotaBytes: 1_000_000,
      serverQuotaBytes: 5_000_000,
      tempQuotaBytes: 5_000_000,
    })
    const userA = actor('a') as User
    const userB = actor('b') as User
    const roomId = mountRoom([userA, userB])

    const first = await assetFor(service, roomId, actor('a'))
    expect(service.snapshot(roomId).usage.roomBytes).toBe(700_000)
    const secondTask = await upload(service, roomId, actor('b'))
    const failed = await waitForTask(service, roomId, secondTask, 'failed')
    expect(failed.errorCode).toBe('LOCAL_AUDIO_QUOTA_EXCEEDED')
    expect(service.snapshot(roomId).assets).toHaveLength(1)
    expect(service.snapshot(roomId).assets[0].assetId).toBe(first.assetId)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
  })

  it('enforces final server quota across rooms', async () => {
    const service = await makeService({
      media: fakeMedia({ outputBytes: 700_000 }),
      roomQuotaBytes: 2_000_000,
      serverQuotaBytes: 1_000_000,
      tempQuotaBytes: 5_000_000,
    })
    const roomA = mountRoom([actor('a') as User])
    const roomB = mountRoom([actor('b') as User])
    await assetFor(service, roomA, actor('a'))
    const secondTask = await upload(service, roomB, actor('b'))
    const failed = await waitForTask(service, roomB, secondTask, 'failed')
    expect(failed.errorCode).toBe('LOCAL_AUDIO_QUOTA_EXCEEDED')
    expect(service.snapshot(roomA).usage.serverBytes).toBe(700_000)
    expect(service.snapshot(roomB).usage.serverBytes).toBe(700_000)
  })

  it('rejects task 201 while all 200 room task slots are still active', async () => {
    const users = Array.from({ length: 201 }, (_, index) => actor(`user-${index}`) as User)
    const service = await makeService({ maxUploadBytes: 10, tempQuotaBytes: 1_000 })
    await service.initialize()
    const roomId = mountRoom(users)
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    vi.spyOn(internals, 'freeBytes').mockResolvedValue(Number.MAX_SAFE_INTEGER)

    for (let index = 0; index < 200; index += 1) {
      await expect(
        service.createTask(roomId, actor(`user-${index}`), {
          fileName: `${index}.mp3`,
          fileSize: 1,
          addToQueue: false,
        }),
      ).resolves.toMatchObject({ stage: 'waiting-upload' })
    }

    await expect(
      service.createTask(roomId, actor('user-200'), {
        fileName: 'overflow.mp3',
        fileSize: 1,
        addToQueue: false,
      }),
    ).rejects.toThrow('LOCAL_AUDIO_TASK_LIMIT')
    expect(service.snapshot(roomId).tasks).toHaveLength(200)
  })
})

describe('LocalAudioService receive/cancel behavior', () => {
  it('cleans a body that exceeds the declared size', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'bad.mp3',
      fileSize: 4,
      addToQueue: false,
    })

    await expect(
      service.receiveUpload({
        taskId: task.taskId,
        roomId,
        actor: actor('owner', 'owner'),
        request: body(5),
        contentLength: 4,
      }),
    ).rejects.toThrow('TOO_LARGE')
    const failed = await waitForTask(service, roomId, task.taskId, 'failed')
    expect(failed.errorCode).toBe('UPLOAD_INTERRUPTED')
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('cleans an interrupted body and exact-length mismatch', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'short.mp3',
      fileSize: 5,
      addToQueue: false,
    })

    await expect(
      service.receiveUpload({
        taskId: task.taskId,
        roomId,
        actor: actor('owner', 'owner'),
        request: body(3),
        contentLength: 5,
      }),
    ).rejects.toThrow('INCOMPLETE')
    const failed = await waitForTask(service, roomId, task.taskId, 'failed')
    expect(failed.errorCode).toBe('UPLOAD_INTERRUPTED')
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('rejects a Content-Length that differs from task preflight and releases its reservation', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'mismatch.mp3',
      fileSize: 5,
      addToQueue: false,
    })

    await expect(
      service.receiveUpload({
        taskId: task.taskId,
        roomId,
        actor: actor('owner', 'owner'),
        request: body(4),
        contentLength: 4,
      }),
    ).rejects.toThrow('LOCAL_AUDIO_INVALID_SIZE')
    const failed = await waitForTask(service, roomId, task.taskId, 'failed')
    expect(failed.errorCode).toBe('INVALID_CONTENT_LENGTH')
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('makes cancellation idempotent and releases the reservation once', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'cancel.mp3',
      fileSize: 5,
      addToQueue: false,
    })

    await expect(service.cancelTask(roomId, task.taskId, actor('owner', 'owner'))).resolves.toBe(true)
    await expect(service.cancelTask(roomId, task.taskId, actor('owner', 'owner'))).resolves.toBe(false)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(service.snapshot(roomId).tasks.find((item) => item.taskId === task.taskId)?.stage).toBe('cancelled')
  })

  it('retains temporary quota until a failed input deletion retries successfully', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'busy-input.mp3',
      fileSize: 5,
      addToQueue: false,
    })
    const internals = service as unknown as { removeTaskTempFiles: (record: unknown) => Promise<void> }
    const removeSpy = vi.spyOn(internals, 'removeTaskTempFiles').mockRejectedValueOnce(new Error('EBUSY'))

    await expect(service.cancelTask(roomId, task.taskId, actor('owner', 'owner'))).resolves.toBe(true)
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1))
    expect(service.snapshot(roomId).usage.tempBytes).toBe(5)

    await vi.waitFor(() => expect(service.snapshot(roomId).usage.tempBytes).toBe(0), {
      timeout: 2_500,
      interval: 25,
    })
    expect(removeSpy).toHaveBeenCalledTimes(2)
  })

  it('cancels waiting uploads only for the room the user actually left', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const sharedUser = actor('same-user')
    const roomA = mountRoom([sharedUser as User])
    const otherUser = actor('other-user')
    const roomB = mountRoom([otherUser as User])
    const taskA = await service.createTask(roomA, sharedUser, {
      fileName: 'room-a.mp3',
      fileSize: 5,
      addToQueue: false,
    })
    const taskB = await service.createTask(roomB, otherUser, {
      fileName: 'room-b.mp3',
      fileSize: 7,
      addToQueue: false,
    })
    // Simulate a stale duplicate upload record for the same identity in a
    // different room. The cancellation API must still be room-scoped.
    const internals = service as unknown as {
      rooms: Map<string, { tasks: Map<string, { uploadedByUserId: string }> }>
    }
    internals.rooms.get(roomB)!.tasks.get(taskB.taskId)!.uploadedByUserId = sharedUser.id

    service.cancelReceivingForUser(roomA, sharedUser.id)
    await vi.waitFor(() =>
      expect(service.snapshot(roomA).tasks.find((item) => item.taskId === taskA.taskId)?.stage).toBe('cancelled'),
    )

    expect(service.snapshot(roomB).tasks.find((item) => item.taskId === taskB.taskId)?.stage).toBe('waiting-upload')
    await vi.waitFor(() => expect(service.snapshot(roomB).usage.tempBytes).toBe(7))
  })

  it('cancels a receiving request and cleans its partial file', async () => {
    const service = await makeService({ maxUploadBytes: 1_000, tempQuotaBytes: 2_000 })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'stream.mp3',
      fileSize: 100,
      addToQueue: false,
    })
    const request = new PassThrough()
    const receiving = service.receiveUpload({
      taskId: task.taskId,
      roomId,
      actor: actor('owner', 'owner'),
      request,
      contentLength: 100,
    })
    // Cancellation destroys the request immediately, so observe the rejection
    // before awaiting any other promise to avoid an unhandled-rejection race.
    const receivingOutcome = receiving.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await vi.waitFor(() =>
      expect(service.snapshot(roomId).tasks.find((item) => item.taskId === task.taskId)?.stage).toBe('receiving'),
    )
    const cancelled = service.cancelTask(roomId, task.taskId, actor('owner', 'owner'))
    request.write(Buffer.alloc(10))
    request.end()
    await expect(cancelled).resolves.toBe(true)
    await expect(receivingOutcome).resolves.toMatchObject({ ok: false })
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('cancels a receiving request that stays idle for the input timeout', async () => {
    vi.useFakeTimers()
    try {
      const service = await makeService({ maxUploadBytes: 1_000, tempQuotaBytes: 2_000 })
      const roomId = mountRoom([actor('owner', 'owner') as User])
      const task = await service.createTask(roomId, actor('owner', 'owner'), {
        fileName: 'idle.mp3',
        fileSize: 100,
        addToQueue: false,
      })
      const request = new PassThrough()
      request.on('error', () => undefined)
      const receiving = service.receiveUpload({
        taskId: task.taskId,
        roomId,
        actor: actor('owner', 'owner'),
        request,
        contentLength: 100,
      })
      const receivingOutcome = receiving.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await vi.waitFor(
        () =>
          expect(service.snapshot(roomId).tasks.find((item) => item.taskId === task.taskId)?.stage).toBe('receiving'),
        { timeout: 1_000, interval: 10 },
      )
      await vi.advanceTimersByTimeAsync(60_001)
      await expect(receivingOutcome).resolves.toMatchObject({ ok: false })
      expect(service.snapshot(roomId).tasks.find((item) => item.taskId === task.taskId)?.stage).toBe('cancelled')
      await vi.waitFor(() => expect(service.snapshot(roomId).usage.tempBytes).toBe(0))
      expect(await readdir(service.tempDir)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels processing without committing an asset or leaking reservations', async () => {
    let started!: () => void
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const releaseProbe = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = await makeService({
      media: fakeMedia({
        probe: async ({ signal }) => {
          started()
          await releaseProbe
          if (signal?.aborted) throw new Error('ABORTED')
          return metadata()
        },
      }),
    })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const taskId = await upload(service, roomId, actor('owner', 'owner'))
    await probeStarted
    await vi.waitFor(() =>
      expect(service.snapshot(roomId).tasks.find((item) => item.taskId === taskId)?.stage).toBe('probing'),
    )
    // 进度不应回退：分析阶段保持上传后的高位（原实现会重置为 0）
    expect(service.snapshot(roomId).tasks.find((item) => item.taskId === taskId)?.progress).toBeGreaterThan(0.9)

    const firstCancel = service.cancelTask(roomId, taskId, actor('owner', 'owner'))
    const secondCancel = service.cancelTask(roomId, taskId, actor('owner', 'owner'))
    await expect(firstCancel).resolves.toBe(true)
    await expect(secondCancel).resolves.toBe(false)
    release()
    await waitForTask(service, roomId, taskId, 'cancelled')
    expect(service.snapshot(roomId).assets).toHaveLength(0)
    await vi.waitFor(() => expect(service.snapshot(roomId).usage.tempBytes).toBe(0))
    expect(service.snapshot(roomId).usage.serverBytes).toBe(0)
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('does not commit a task when its room is cleaned up during a held transcode', async () => {
    let started!: () => void
    const transcodeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const releaseTranscode = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = await makeService({
      media: fakeMedia({
        onTranscode: async () => {
          started()
          await releaseTranscode
        },
      }),
    })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const taskId = await upload(service, roomId, actor('owner', 'owner'))
    await transcodeStarted
    await vi.waitFor(() =>
      expect(service.snapshot(roomId).tasks.find((item) => item.taskId === taskId)?.stage).toBe('transcoding'),
    )
    // 转码开始进度应保持单调（高于上传阶段的 0.95 起点）
    expect(service.snapshot(roomId).tasks.find((item) => item.taskId === taskId)?.progress).toBeGreaterThan(0.95)

    await service.cleanupRoom(roomId)
    release()
    await vi.waitFor(() => expect(service.snapshot(roomId).tasks).toHaveLength(0))
    expect(service.snapshot(roomId).assets).toHaveLength(0)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(service.snapshot(roomId).usage.serverBytes).toBe(0)
    expect(await readdir(service.tempDir)).toEqual([])
  })

  it('does not leak a final reservation when room cleanup races the free-space check', async () => {
    const service = await makeService({
      roomQuotaBytes: 1_000_000,
      serverQuotaBytes: 1_000_000,
      media: fakeMedia(),
    })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'race.mp3',
      fileSize: 8,
      addToQueue: false,
    })
    let release!: () => void
    const freeSpaceRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    let reachedFreeSpace!: () => void
    const freeSpaceReached = new Promise<void>((resolve) => {
      reachedFreeSpace = resolve
    })
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    const freeBytesSpy = vi.spyOn(internals, 'freeBytes').mockImplementationOnce(async () => {
      reachedFreeSpace()
      await freeSpaceRelease
      return Number.MAX_SAFE_INTEGER
    })

    await service.receiveUpload({
      taskId: task.taskId,
      roomId,
      actor: actor('owner', 'owner'),
      request: body(8),
      contentLength: 8,
    })
    await freeSpaceReached
    await service.cleanupRoom(roomId)
    release()
    await vi.waitFor(() => expect(service.snapshot(roomId).usage.serverBytes).toBe(0))
    freeBytesSpy.mockRestore()

    // A leaked reservation would make this otherwise valid task fail its
    // server quota preflight/reservation.
    const nextRoomId = mountRoom([actor('next-owner', 'owner') as User])
    const nextTaskId = await upload(service, nextRoomId, actor('next-owner', 'owner'))
    await waitForTask(service, nextRoomId, nextTaskId, 'ready')
  })

  it('does not commit an asset when cleanup races the actual-size disk check', async () => {
    const service = await makeService({
      roomQuotaBytes: 1_000_000,
      serverQuotaBytes: 1_000_000,
      media: fakeMedia(),
    })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const task = await service.createTask(roomId, actor('owner', 'owner'), {
      fileName: 'actual-race.mp3',
      fileSize: 8,
      addToQueue: false,
    })
    let freeCall = 0
    let release!: () => void
    const actualFreeRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    let reachedActualFree!: () => void
    const actualFreeReached = new Promise<void>((resolve) => {
      reachedActualFree = resolve
    })
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    const freeBytesSpy = vi.spyOn(internals, 'freeBytes').mockImplementation(async () => {
      freeCall += 1
      if (freeCall === 2) {
        reachedActualFree()
        await actualFreeRelease
      }
      return Number.MAX_SAFE_INTEGER
    })

    await service.receiveUpload({
      taskId: task.taskId,
      roomId,
      actor: actor('owner', 'owner'),
      request: body(8),
      contentLength: 8,
    })
    await actualFreeReached
    await service.cleanupRoom(roomId)
    release()
    await vi.waitFor(() => expect(service.snapshot(roomId).usage.serverBytes).toBe(0))
    freeBytesSpy.mockRestore()

    const nextRoomId = mountRoom([actor('next-owner', 'owner') as User])
    const nextTaskId = await upload(service, nextRoomId, actor('next-owner', 'owner'))
    await waitForTask(service, nextRoomId, nextTaskId, 'ready')
    expect(service.snapshot(nextRoomId).usage.serverBytes).toBe(32)
  })

  it('rechecks user and temporary quotas after concurrent createTask preflights', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 10 })
    await service.initialize()
    const roomA = mountRoom([actor('same-user') as User])
    const roomB = mountRoom([actor('same-user') as User])
    let release!: () => void
    const freeRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = 0
    let releaseBoth!: () => void
    const bothReached = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    const freeBytesSpy = vi.spyOn(internals, 'freeBytes').mockImplementation(async () => {
      reached += 1
      if (reached === 2) releaseBoth()
      await freeRelease
      return Number.MAX_SAFE_INTEGER
    })

    const first = service.createTask(roomA, actor('same-user'), { fileName: 'a.mp3', fileSize: 6, addToQueue: false })
    const second = service.createTask(roomB, actor('same-user'), { fileName: 'b.mp3', fileSize: 6, addToQueue: false })
    await bothReached
    release()
    const results = await Promise.allSettled([first, second])
    freeBytesSpy.mockRestore()
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/LOCAL_AUDIO_BUSY|LOCAL_AUDIO_QUOTA_EXCEEDED/),
      }),
    })
    expect(service.snapshot(roomA).tasks.length + service.snapshot(roomB).tasks.length).toBe(1)
    expect(service.snapshot(roomA).usage.tempBytes).toBe(6)
  })

  it('prevents different users from oversubscribing temp quota across concurrent preflights', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 10 })
    await service.initialize()
    const roomA = mountRoom([actor('user-a') as User])
    const roomB = mountRoom([actor('user-b') as User])
    let release!: () => void
    const freeRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = 0
    let releaseBoth!: () => void
    const bothReached = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    const freeBytesSpy = vi.spyOn(internals, 'freeBytes').mockImplementation(async () => {
      reached += 1
      if (reached === 2) releaseBoth()
      await freeRelease
      return Number.MAX_SAFE_INTEGER
    })

    const first = service.createTask(roomA, actor('user-a'), { fileName: 'a.mp3', fileSize: 6, addToQueue: false })
    const second = service.createTask(roomB, actor('user-b'), { fileName: 'b.mp3', fileSize: 6, addToQueue: false })
    await bothReached
    release()
    const results = await Promise.allSettled([first, second])
    freeBytesSpy.mockRestore()
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'LOCAL_AUDIO_QUOTA_EXCEEDED' }),
    })
    expect(service.snapshot(roomA).usage.tempBytes).toBe(6)
  })

  it('waits for an old room cleanup before allocating files for a recreated room ID', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('old-owner', 'owner') as User])
    await assetFor(service, roomId, actor('old-owner', 'owner'))
    const cleanup = service.cleanupRoom(roomId)

    // Recreate the room immediately, before the old asset directory removal
    // has resolved. The new upload must not be deleted by the old cleanup.
    const recreated = room(roomId, [actor('new-owner', 'owner') as User])
    roomRepo.set(roomId, recreated)
    chatRepo.createRoom(roomId)
    const taskId = await upload(service, roomId, actor('new-owner', 'owner'))
    await cleanup
    await waitForTask(service, roomId, taskId, 'ready')
    const asset = service.snapshot(roomId).assets[0]
    expect(asset).toBeTruthy()
    await expect(stat(service.getAsset(roomId, asset.assetId)!.primaryPath)).resolves.toBeTruthy()
  })
})

describe('LocalAudioService processing and queue identity', () => {
  it.each([
    {
      limitingBudget: 'room',
      roomQuotaBytes: 200_000,
      serverQuotaBytes: 300_000,
      freeBytes: 400_000,
      expected: 200_000,
    },
    {
      limitingBudget: 'server',
      roomQuotaBytes: 300_000,
      serverQuotaBytes: 210_000,
      freeBytes: 400_000,
      expected: 210_000,
    },
    {
      limitingBudget: 'disk',
      roomQuotaBytes: 300_000,
      serverQuotaBytes: 400_000,
      freeBytes: 220_000,
      expected: 220_000,
    },
  ])(
    'passes the dynamic $limitingBudget aggregate ceiling to the primary output',
    async ({ roomQuotaBytes, serverQuotaBytes, freeBytes, expected }) => {
      const requests: Array<{ maxOutputBytes?: number }> = []
      const service = await makeService({
        media: fakeMedia({
          onTranscodeRequest: async (request) => {
            requests.push(request)
          },
        }),
        roomQuotaBytes,
        serverQuotaBytes,
      })
      const roomId = mountRoom([actor('owner', 'owner') as User])
      const internals = service as unknown as { freeBytes: () => Promise<number> }
      vi.spyOn(internals, 'freeBytes').mockResolvedValue(freeBytes)

      const taskId = await upload(service, roomId, actor('owner', 'owner'))
      await waitForTask(service, roomId, taskId, 'ready')

      expect(requests).toHaveLength(1)
      expect(requests[0].maxOutputBytes).toBe(expected)
    },
  )

  it('shares one aggregate budget across lossless primary, MP3 fallback, and cover output', async () => {
    const transcodeBudgets: number[] = []
    const coverBudgets: number[] = []
    const aggregateLimit = 1_200_000
    const outputBytes = 100
    const service = await makeService({
      media: fakeMedia({
        outputBytes,
        coverBytes: 100,
        probe: async () =>
          metadata({
            container: 'flac',
            codec: 'flac',
            format: 'flac',
            lossless: true,
            hasEmbeddedCover: true,
          }),
        onTranscodeRequest: async ({ maxOutputBytes }) => {
          transcodeBudgets.push(maxOutputBytes ?? -1)
        },
        onExtractCoverRequest: async ({ maxBytes }) => {
          coverBudgets.push(maxBytes ?? -1)
        },
      }),
      roomQuotaBytes: aggregateLimit,
      serverQuotaBytes: 2_000_000,
    })
    const roomId = mountRoom([actor('owner', 'owner') as User], 999)

    const taskId = await upload(service, roomId, actor('owner', 'owner'))
    await waitForTask(service, roomId, taskId, 'ready')

    const audioBudget = aggregateLimit - LOCAL_AUDIO_MEDIA_LIMITS.coverMaxBytes
    expect(transcodeBudgets).toEqual([audioBudget, audioBudget - outputBytes])
    expect(coverBudgets).toEqual([LOCAL_AUDIO_MEDIA_LIMITS.coverMaxBytes])
    expect(service.snapshot(roomId).usage.roomBytes).toBe(outputBytes * 2 + 100)
  })

  it('rejects aggregate output that exceeds the hard cap even when the media boundary ignores it', async () => {
    const aggregateLimit = 200_000
    const service = await makeService({
      media: fakeMedia({ outputBytes: aggregateLimit + 1 }),
      roomQuotaBytes: aggregateLimit,
      serverQuotaBytes: 300_000,
    })
    const roomId = mountRoom([actor('owner', 'owner') as User])

    const taskId = await upload(service, roomId, actor('owner', 'owner'))
    const failed = await waitForTask(service, roomId, taskId, 'failed')

    expect(failed.errorCode).toBe('LOCAL_AUDIO_QUOTA_EXCEEDED')
    expect(service.snapshot(roomId).assets).toHaveLength(0)
    await vi.waitFor(() => expect(service.snapshot(roomId).usage.tempBytes).toBe(0))
  })

  it('allows the same user to create and receive another task after their previous task is queued', async () => {
    let started!: () => void
    const firstProbeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const firstProbeRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    let probeCount = 0
    const service = await makeService({
      media: fakeMedia({
        probe: async ({ signal }) => {
          probeCount += 1
          if (probeCount === 1) {
            started()
            await firstProbeRelease
          }
          if (signal?.aborted) throw new Error('ABORTED')
          return metadata()
        },
      }),
      roomQuotaBytes: 1_000_000,
      serverQuotaBytes: 1_000_000,
      tempQuotaBytes: 1_000_000,
    })
    const blocker = actor('blocker')
    const uploader = actor('uploader')
    const roomId = mountRoom([blocker as User, uploader as User])

    try {
      const blockerTaskId = await upload(service, roomId, blocker)
      await firstProbeStarted
      const queuedTaskId = await upload(service, roomId, uploader)
      await vi.waitFor(() =>
        expect(service.snapshot(roomId).tasks.find((item) => item.taskId === queuedTaskId)?.stage).toBe('queued'),
      )
      // 上传完成后进度不应重置为 0
      expect(service.snapshot(roomId).tasks.find((item) => item.taskId === queuedTaskId)?.progress).toBeGreaterThan(0.9)

      const next = await service.createTask(roomId, uploader, {
        fileName: 'next.mp3',
        fileSize: 8,
        addToQueue: false,
      })
      await expect(
        service.receiveUpload({
          taskId: next.taskId,
          roomId,
          actor: uploader,
          request: body(8),
          contentLength: 8,
        }),
      ).resolves.toMatchObject({ stage: 'queued' })

      release()
      await waitForTask(service, roomId, blockerTaskId, 'ready')
      await waitForTask(service, roomId, queuedTaskId, 'ready')
      await waitForTask(service, roomId, next.taskId, 'ready')
    } finally {
      release?.()
    }
  })

  it('allows the same user to receive task 2 while task 1 is transcoding', async () => {
    let started!: () => void
    const transcodeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const transcodeRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    let transcodeCount = 0
    const service = await makeService({
      media: fakeMedia({
        onTranscode: async () => {
          transcodeCount += 1
          if (transcodeCount === 1) {
            started()
            await transcodeRelease
          }
        },
      }),
      roomQuotaBytes: 200_000,
      serverQuotaBytes: 200_000,
      tempQuotaBytes: 1_000_000,
    })
    const uploader = actor('owner', 'owner')
    const roomId = mountRoom([uploader as User])

    try {
      const firstTaskId = await upload(service, roomId, uploader)
      await transcodeStarted
      const second = await service.createTask(roomId, uploader, {
        fileName: 'second.mp3',
        fileSize: 8,
        addToQueue: false,
      })
      await service.receiveUpload({
        taskId: second.taskId,
        roomId,
        actor: uploader,
        request: body(8),
        contentLength: 8,
      })
      await vi.waitFor(() =>
        expect(service.snapshot(roomId).tasks.find((item) => item.taskId === second.taskId)?.stage).toBe('queued'),
      )

      release()
      await waitForTask(service, roomId, firstTaskId, 'ready')
      await waitForTask(service, roomId, second.taskId, 'ready')
    } finally {
      release?.()
    }
  })

  it('counts an in-flight final reservation in the next raw upload disk preflight', async () => {
    let started!: () => void
    const transcodeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const transcodeRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = await makeService({
      media: fakeMedia({
        onTranscode: async () => {
          started()
          await transcodeRelease
        },
      }),
      maxUploadBytes: 50_000,
      roomQuotaBytes: 180_000,
      serverQuotaBytes: 180_000,
      tempQuotaBytes: 1_000_000,
      minFreeBytes: 20_000,
    })
    const uploader = actor('owner', 'owner')
    const roomId = mountRoom([uploader as User])
    const internals = service as unknown as { freeBytes: () => Promise<number> }
    vi.spyOn(internals, 'freeBytes').mockResolvedValue(220_000)

    try {
      await upload(service, roomId, uploader)
      await transcodeStarted

      await expect(
        service.createTask(roomId, uploader, {
          fileName: 'would-overlap.mp3',
          fileSize: 20_001,
          addToQueue: false,
        }),
      ).rejects.toThrow('LOCAL_AUDIO_DISK_LOW')
    } finally {
      release?.()
    }
  })

  it('retains failed-output accounting until directory deletion retries successfully', async () => {
    const aggregateLimit = 200_000
    const service = await makeService({
      media: fakeMedia({
        onTranscodeRequest: async () => {
          throw new Error('transcode integration failed')
        },
      }),
      roomQuotaBytes: aggregateLimit,
      serverQuotaBytes: aggregateLimit,
    })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const internals = service as unknown as {
      finalReservedBytes: number
      removeTaskOutputDirectory: (outputDir: string) => Promise<void>
    }
    const removeSpy = vi.spyOn(internals, 'removeTaskOutputDirectory').mockRejectedValueOnce(new Error('EBUSY'))

    const taskId = await upload(service, roomId, actor('owner', 'owner'))
    await waitForTask(service, roomId, taskId, 'failed')
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1))
    expect(internals.finalReservedBytes).toBe(aggregateLimit)

    await vi.waitFor(() => expect(internals.finalReservedBytes).toBe(0), {
      timeout: 2_500,
      interval: 25,
    })
    expect(removeSpy).toHaveBeenCalledTimes(2)
  })

  it('processes at most one task at a time', async () => {
    let active = 0
    let maxActive = 0
    let firstProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => {
      firstProbeStarted = resolve
    })
    let releaseFirstProbe!: () => void
    const firstProbeRelease = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve
    })
    let probeCount = 0
    const media = fakeMedia({
      probe: async ({ signal }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        probeCount += 1
        if (probeCount === 1) {
          firstProbeStarted()
          await firstProbeRelease
        }
        if (signal?.aborted) throw new Error('ABORTED')
        active -= 1
        return metadata()
      },
      onTranscode: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
      },
    })
    const service = await makeService({ media, roomQuotaBytes: 5_000_000, serverQuotaBytes: 10_000_000 })
    const roomId = mountRoom([actor('a') as User, actor('b') as User])
    const taskA = await service.createTask(roomId, actor('a'), { fileName: 'a.mp3', fileSize: 8, addToQueue: false })
    await service.receiveUpload({ taskId: taskA.taskId, roomId, actor: actor('a'), request: body(8), contentLength: 8 })
    await probeStarted
    const taskB = await service.createTask(roomId, actor('b'), { fileName: 'b.mp3', fileSize: 8, addToQueue: false })
    await service.receiveUpload({ taskId: taskB.taskId, roomId, actor: actor('b'), request: body(8), contentLength: 8 })
    await vi.waitFor(() =>
      expect(service.snapshot(roomId).tasks.find((item) => item.taskId === taskB.taskId)?.stage).toBe('queued'),
    )
    expect(maxActive).toBe(1)
    releaseFirstProbe()
    await waitForTask(service, roomId, taskA.taskId, 'ready')
    await waitForTask(service, roomId, taskB.taskId, 'ready')
    expect(maxActive).toBe(1)
  })

  it('keeps asset identity separate from each queue item and permits repeated enqueue', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const first = await service.addAssetToQueue(roomId, assetId, 'owner', false)
    const second = await service.addAssetToQueue(roomId, assetId, 'owner', false)
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first!.assetId).toBe(assetId)
    expect(second!.assetId).toBe(assetId)
    expect(first!.id).not.toBe(assetId)
    expect(second!.id).not.toBe(assetId)
    expect(second!.id).not.toBe(first!.id)
    expect(roomRepo.get(roomId)?.queue).toHaveLength(2)
  })

  it('keeps a successful asset ready and warns only its uploader when automatic enqueue is full', async () => {
    const emissions: Array<{ target: string | string[]; event: string; payload: unknown }> = []
    const io = {
      to: vi.fn((target: string | string[]) => ({
        emit: (event: string, payload: unknown) => {
          emissions.push({ target, event, payload })
        },
      })),
    } as unknown as TypedServer
    const service = await makeService({ media: fakeMedia(), io })
    const uploader = actor('owner', 'owner')
    const roomId = mountRoom([uploader as User])
    roomRepo.get(roomId)!.maxQueueSize = 0
    const uploaderSocketId = `socket-${roomId}`
    roomRepo.setSocketMapping(uploaderSocketId, roomId, uploader.id)

    const taskId = await upload(service, roomId, uploader, 8, true)
    const ready = await waitForTask(service, roomId, taskId, 'ready')
    await vi.waitFor(() => expect(emissions.some(({ event }) => event === EVENTS.ROOM_ERROR)).toBe(true))

    expect(ready.assetId).toBeTruthy()
    expect(service.snapshot(roomId).assets).toHaveLength(1)
    expect(roomRepo.get(roomId)?.queue).toHaveLength(0)
    const errors = emissions.filter(({ event }) => event === EVENTS.ROOM_ERROR)
    expect(errors).toEqual([
      {
        target: uploaderSocketId,
        event: EVENTS.ROOM_ERROR,
        payload: {
          code: ERROR_CODE.QUEUE_FULL,
          message: '本地音频上传成功，但播放列表已满，未自动加入',
        },
      },
    ])
  })

  it('broadcasts authoritative usage after create, cleanup, ready commit, and physical asset deletion', async () => {
    const states: Array<ReturnType<LocalAudioService['snapshot']>> = []
    const io = {
      to: vi.fn(() => ({
        emit: (event: string, payload: ReturnType<LocalAudioService['snapshot']>) => {
          if (event === EVENTS.LOCAL_AUDIO_STATE) states.push(payload)
        },
      })),
    } as unknown as TypedServer
    const service = await makeService({ media: fakeMedia(), io, maxUploadBytes: 100, tempQuotaBytes: 1_000 })
    const uploader = actor('owner', 'owner')
    const roomId = mountRoom([uploader as User])

    const cancelled = await service.createTask(roomId, uploader, {
      fileName: 'cancelled.mp3',
      fileSize: 5,
      addToQueue: false,
    })
    expect(states.at(-1)?.usage.tempBytes).toBe(5)
    await service.cancelTask(roomId, cancelled.taskId, uploader)
    expect(states.at(-1)?.usage.tempBytes).toBe(0)

    const { assetId } = await assetFor(service, roomId, uploader)
    await vi.waitFor(() =>
      expect(states.some(({ usage }) => usage.roomBytes === 32 && usage.serverBytes === 32)).toBe(true),
    )

    const primaryPath = service.getAsset(roomId, assetId)!.primaryPath
    await service.deleteAsset(roomId, assetId, uploader, false)
    await vi.waitFor(
      async () => {
        await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(states.at(-1)?.usage).toMatchObject({ roomBytes: 0, serverBytes: 0, tempBytes: 0 })
      },
      {
        timeout: 2_500,
        interval: 25,
      },
    )
  })

  it('only permits pending-delete refresh for the track that is still playing', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const track = service.buildTrack(roomId, assetId, 'owner')!
    const data = roomRepo.get(roomId)!
    data.currentTrack = track

    await service.deleteAsset(roomId, assetId, actor('owner', 'owner'), false)
    expect(service.refreshTrack(roomId, track)).toBeNull()
    expect(service.refreshTrack(roomId, track, true)).toMatchObject({ id: track.id, assetId })
    data.currentTrack = null
    expect(service.refreshTrack(roomId, track, true)).toBeNull()
  })
})

describe('LocalAudioService deletion and room cleanup', () => {
  it('plays B rather than skipping to C after current A was already removed', async () => {
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const makeTrack = (id: string): Track => ({
      id,
      title: id,
      artist: ['artist'],
      album: 'album',
      duration: 60,
      cover: '',
      source: 'netease',
      sourceId: id,
      urlId: id,
      streamUrl: `https://example.test/${id}.mp3`,
    })
    const a = makeTrack('A')
    const b = makeTrack('B')
    const c = makeTrack('C')
    const data = roomRepo.get(roomId)!
    data.currentTrack = a
    data.queue = [b, c]
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as TypedServer
    const actualPlayerService = await vi.importActual<typeof import('./playerService.js')>('./playerService.js')

    await actualPlayerService.playNextTrackInRoom(io, roomId, 'sequential', {
      skipDebounce: true,
      previousIndex: 0,
      currentAlreadyRemoved: true,
      skipHistory: true,
    })
    expect(data.currentTrack?.id).toBe('B')
    actualPlayerService.cleanupRoom(roomId)
  })

  it('delays physical deletion while the asset is the current track, then clears references', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const asset = service.getAsset(roomId, assetId)!
    const track = service.buildTrack(roomId, assetId, 'owner')!
    const data = roomRepo.get(roomId)!
    data.queue = [track]
    data.currentTrack = track
    const ref: DefaultQueueTrackRef = {
      id: track.id,
      source: 'local',
      sourceId: track.sourceId,
      title: track.title,
      artist: track.artist,
      assetId: track.assetId,
    }
    data.defaultQueue = [ref]
    data.playedHistory = [{ track, playedAt: Date.now(), requestedBy: 'owner' }]

    await expect(service.deleteAsset(roomId, assetId, actor('owner', 'owner'), false)).resolves.toBe(true)
    expect(asset.pendingDelete).toBe(true)
    await expect(stat(asset.primaryPath)).resolves.toBeTruthy()
    expect(data.queue).toHaveLength(1)
    data.currentTrack = null
    await vi.waitFor(
      async () => {
        await expect(stat(asset.primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 2500, interval: 25 },
    )
    expect(service.snapshot(roomId).assets).toHaveLength(0)
    expect(data.queue).toHaveLength(0)
    expect(data.defaultQueue).toHaveLength(0)
    expect(data.playedHistory).toHaveLength(0)
  })

  it('keeps the current pending-delete stream alive until playback moves away, then closes it', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const asset = service.getAsset(roomId, assetId)!
    const track = service.buildTrack(roomId, assetId, 'owner')!
    const data = roomRepo.get(roomId)!
    data.queue = [track]
    data.currentTrack = track
    const primaryPath = asset.primaryPath
    let releaseStream!: () => void
    const closeStream = vi.fn(() => releaseStream())
    releaseStream = service.beginStream(asset, closeStream)

    await service.deleteAsset(roomId, assetId, actor('owner', 'owner'), false)
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect(closeStream).not.toHaveBeenCalled()
    await expect(stat(primaryPath)).resolves.toBeTruthy()
    data.currentTrack = null
    await vi.waitFor(
      async () => {
        await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 2500, interval: 25 },
    )
    expect(closeStream).toHaveBeenCalledTimes(1)
  })

  it('actively closes a non-current stream before deleting its pending asset', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const asset = service.getAsset(roomId, assetId)!
    const primaryPath = asset.primaryPath
    let releaseStream!: () => void
    const closeStream = vi.fn(() => releaseStream())
    releaseStream = service.beginStream(asset, closeStream)

    await service.deleteAsset(roomId, assetId, actor('owner', 'owner'), false)
    await vi.waitFor(() => expect(closeStream).toHaveBeenCalledTimes(1), { timeout: 2500, interval: 25 })
    await vi.waitFor(
      async () => {
        await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 2500, interval: 25 },
    )
  })

  it('retains a pending asset and its quota until a failed filesystem deletion retries successfully', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const asset = service.getAsset(roomId, assetId)!
    const primaryPath = asset.primaryPath
    const serverBytes = service.snapshot(roomId).usage.serverBytes
    const internals = service as unknown as { removeAssetDirectory: (record: unknown) => Promise<void> }
    const removeSpy = vi.spyOn(internals, 'removeAssetDirectory').mockRejectedValueOnce(new Error('EBUSY'))

    await service.deleteAsset(roomId, assetId, actor('owner', 'owner'), false)
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1), { timeout: 2500, interval: 25 })
    expect(service.getAsset(roomId, assetId)).toBe(asset)
    expect(service.snapshot(roomId).usage.serverBytes).toBe(serverBytes)
    await expect(stat(primaryPath)).resolves.toBeTruthy()

    await vi.waitFor(
      async () => {
        await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 2500, interval: 25 },
    )
    expect(removeSpy).toHaveBeenCalledTimes(2)
    expect(service.getAsset(roomId, assetId)).toBeUndefined()
    expect(service.snapshot(roomId).usage.serverBytes).toBe(0)
  })

  it('removes the current queue item immediately and requests synchronized playback advance', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const track = service.buildTrack(roomId, assetId, 'owner')!
    const primaryPath = service.getAsset(roomId, assetId)!.primaryPath
    const data = roomRepo.get(roomId)!
    data.queue = [track]
    data.currentTrack = track
    data.defaultQueue = [track]
    data.playedHistory = [{ track, playedAt: Date.now(), requestedBy: 'owner' }]
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as TypedServer
    service.setIo(io)

    await expect(service.deleteAsset(roomId, assetId, actor('owner', 'owner'), true)).resolves.toBe(true)
    expect(data.queue).toHaveLength(0)
    expect(data.defaultQueue).toHaveLength(0)
    expect(data.playedHistory).toHaveLength(0)
    expect(playerMocks.playNextTrackInRoom).toHaveBeenCalledWith(
      io,
      roomId,
      data.playMode,
      expect.objectContaining({
        skipDebounce: true,
        currentAlreadyRemoved: true,
        skipHistory: true,
        stopBeforeResolve: true,
      }),
    )
    data.currentTrack = null
    await vi.waitFor(
      async () => {
        await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 2500, interval: 25 },
    )
  })

  it('keeps a deletion timer installed when synchronized playback advance rejects', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const asset = service.getAsset(roomId, assetId)!
    const track = service.buildTrack(roomId, assetId, 'owner')!
    const primaryPath = asset.primaryPath
    const data = roomRepo.get(roomId)!
    data.queue = [track]
    data.currentTrack = track
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as TypedServer
    service.setIo(io)
    playerMocks.playNextTrackInRoom.mockRejectedValueOnce(new Error('switch failed'))

    await expect(service.deleteAsset(roomId, assetId, actor('owner', 'owner'), true)).rejects.toThrow('switch failed')
    expect(asset.pendingDelete).toBe(true)
    expect(asset.deleteTimer).toBeDefined()
    data.currentTrack = null
    await vi.waitFor(
      async () => {
        await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      { timeout: 2500, interval: 25 },
    )
  })

  it('retains room reservations until failed room cleanup retries successfully', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000, media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User, actor('pending') as User])
    const { assetId } = await assetFor(service, roomId)
    const assetDir = path.dirname(service.getAsset(roomId, assetId)!.primaryPath)
    await service.createTask(roomId, actor('pending'), {
      fileName: 'pending.mp3',
      fileSize: 10,
      addToQueue: false,
    })
    const before = service.snapshot(roomId).usage
    const internals = service as unknown as { removeRoomFiles: (id: string, index: unknown) => Promise<void> }
    const removeSpy = vi.spyOn(internals, 'removeRoomFiles').mockRejectedValueOnce(new Error('EBUSY'))
    let settled = false

    const cleanup = service.cleanupRoom(roomId)
    void cleanup.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1), { timeout: 2500, interval: 25 })
    expect(settled).toBe(false)
    expect(service.snapshot(roomId).usage.serverBytes).toBe(before.serverBytes)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(before.tempBytes)
    await expect(stat(assetDir)).resolves.toBeTruthy()

    await cleanup
    expect(removeSpy).toHaveBeenCalledTimes(2)
    expect(service.snapshot(roomId).usage.serverBytes).toBe(0)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    await expect(stat(assetDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('closes active room streams during cleanup without releasing final quota twice', async () => {
    const service = await makeService({ media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User])
    const { assetId } = await assetFor(service, roomId)
    const asset = service.getAsset(roomId, assetId)!
    const primaryPath = asset.primaryPath
    expect(service.snapshot(roomId).usage.serverBytes).toBeGreaterThan(0)
    let releaseStream!: () => void
    const closeStream = vi.fn(() => releaseStream())
    releaseStream = service.beginStream(asset, closeStream)

    await service.cleanupRoom(roomId)
    releaseStream()
    expect(closeStream).toHaveBeenCalledTimes(1)
    expect(service.snapshot(roomId).usage.serverBytes).toBe(0)
    await expect(stat(primaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels active tasks and removes all room files during cleanup', async () => {
    const service = await makeService({ maxUploadBytes: 100, tempQuotaBytes: 1_000, media: fakeMedia() })
    const roomId = mountRoom([actor('owner', 'owner') as User, actor('pending') as User])
    const { assetId } = await assetFor(service, roomId)
    const assetDir = path.dirname(service.getAsset(roomId, assetId)!.primaryPath)
    await expect(stat(assetDir)).resolves.toBeTruthy()
    await service.createTask(roomId, actor('pending'), {
      fileName: 'pending.mp3',
      fileSize: 10,
      addToQueue: false,
    })
    expect(service.snapshot(roomId).usage.tempBytes).toBe(10)
    expect(service.snapshot(roomId).usage.serverBytes).toBeGreaterThan(0)

    await service.cleanupRoom(roomId)
    expect(service.snapshot(roomId).assets).toHaveLength(0)
    expect(service.snapshot(roomId).tasks).toHaveLength(0)
    expect(service.snapshot(roomId).usage.tempBytes).toBe(0)
    expect(service.snapshot(roomId).usage.serverBytes).toBe(0)
    await expect(stat(path.join(service.assetsDir, roomId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(assetDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
