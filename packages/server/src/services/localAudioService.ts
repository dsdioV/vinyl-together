import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { nanoid } from 'nanoid'
import pLimit from 'p-limit'
import {
  EVENTS,
  ERROR_CODE,
  LIMITS,
  type AudioQuality,
  type DefaultQueueDelta,
  type LocalAudioAsset,
  type LocalAudioState,
  type LocalAudioTask,
  type Track,
  type User,
} from '@music-together/shared'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { config } from '../config.js'
import { roomRepo } from '../repositories/roomRepository.js'
import * as chatService from './chatService.js'
import * as playerService from './playerService.js'
import * as queueService from './queueService.js'
import {
  createLocalAudioMedia,
  getLocalAudioQualityProfile,
  LOCAL_AUDIO_MEDIA_LIMITS,
  LocalAudioMedia,
  LocalAudioMediaError,
  type LocalAudioMetadata,
  type QualityOutputProfile,
} from './localAudioMedia.js'
import { issueLocalAudioAccessTokenAt, type LocalAudioAccessVariant } from './localAudioAccess.js'
import { toDefaultQueueRef } from '../utils/defaultQueueRef.js'
import { logger } from '../utils/logger.js'
import { toPublicRoomState, toPublicRoomStateForMember } from '../utils/roomUtils.js'

const INPUT_IDLE_TIMEOUT_MS = 60_000
const TASK_RETENTION_MS = 30 * 60_000
const MAX_TASKS_PER_ROOM = 200
const MAX_FILENAME_LENGTH = 255
const MAX_METADATA_LENGTH = 500
const DELETE_RETRY_BASE_MS = 500
const DELETE_RETRY_MAX_MS = 30_000
const STREAM_CLOSE_RETRY_MS = 100

type ActiveStage = Exclude<LocalAudioTask['stage'], 'ready' | 'failed' | 'cancelled'>
type InputStage = Extract<LocalAudioTask['stage'], 'waiting-upload' | 'receiving'>

interface AssetRecord extends LocalAudioAsset {
  roomId: string
  originalFileName: string
  primaryPath: string
  primaryMimeType: 'audio/mpeg' | 'audio/flac'
  primarySizeBytes: number
  fallbackPath?: string
  fallbackSizeBytes?: number
  coverPath?: string
  pendingDelete: boolean
  activeStreams: number
  activeStreamClosers: Set<() => void>
  deleteRetryCount: number
  deleteTimer?: ReturnType<typeof setTimeout>
}

interface TaskRecord extends LocalAudioTask {
  roomId: string
  fileSize: number
  audioQuality: AudioQuality
  inputPath: string
  partPath: string
  abortController: AbortController
  requestDestroy?: () => void
  inputTimer?: ReturnType<typeof setTimeout>
  retentionTimer?: ReturnType<typeof setTimeout>
  cleanupTimer?: ReturnType<typeof setTimeout>
  cleanupPromise?: Promise<boolean>
  cleanupRetryCount: number
  failedOutputDir?: string
  tempReservationHeld: boolean
  finalReservationBytes: number
}

interface RoomIndex {
  assets: Map<string, AssetRecord>
  tasks: Map<string, TaskRecord>
}

export interface CreateTaskInput {
  fileName: string
  fileSize: number
  addToQueue: boolean
}

export interface LocalAudioTaskActor {
  id: string
  nickname: string
  role: User['role']
}

export interface ReceiveUploadInput {
  taskId: string
  roomId: string
  actor: LocalAudioTaskActor
  request: Readable & { headers?: IncomingHttpHeaders; destroyed?: boolean }
  contentLength: number
}

export interface LocalAudioServiceOptions {
  dataDir?: string
  media?: LocalAudioMedia
  io?: TypedServer
  maxUploadBytes?: number
  roomQuotaBytes?: number
  serverQuotaBytes?: number
  tempQuotaBytes?: number
  minFreeBytes?: number
}

function bytesToMiB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

/** 上传阶段的最大进度（0.95），为后续排队/分析/转码保留单调递增空间。 */
const RECEIVING_MAX_PROGRESS = 0.95
/** 转码开始进度。 */
const TRANSCODING_START_PROGRESS = 0.96

function isActiveStage(stage: LocalAudioTask['stage']): stage is ActiveStage {
  return stage !== 'ready' && stage !== 'failed' && stage !== 'cancelled'
}

function isInputStage(stage: LocalAudioTask['stage']): stage is InputStage {
  return stage === 'waiting-upload' || stage === 'receiving'
}

function safeFileName(input: string): string {
  const base = path.basename(String(input ?? ''))
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME_LENGTH)
  return clean || '本地音频'
}

function safeMetadataText(input: string, fallback: string): string {
  const clean = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_LENGTH)
    .trim()
  return clean || fallback
}

function outputEstimateBytes(
  metadata: LocalAudioMetadata,
  profile: { primary: QualityOutputProfile; fallback?: QualityOutputProfile },
  inputSize: number,
): number {
  return (
    outputEstimateForProfile(metadata, profile.primary, inputSize) +
    (profile.fallback ? outputEstimateForProfile(metadata, profile.fallback, inputSize) : 0) +
    (metadata.hasEmbeddedCover ? LOCAL_AUDIO_MEDIA_LIMITS.coverMaxBytes : 0)
  )
}

function outputEstimateForProfile(
  metadata: LocalAudioMetadata,
  output: QualityOutputProfile,
  inputSize: number,
): number {
  if (output.container === 'mp3') {
    // Some malformed inputs omit duration. Bound them relative to the already
    // size-limited upload rather than letting FFmpeg write without a ceiling.
    const encodedBytes =
      metadata.durationSeconds > 0
        ? Math.ceil((metadata.durationSeconds * (output.bitrateKbps ?? 320) * 1000) / 8)
        : Math.ceil(inputSize * 1.25)
    return encodedBytes + 128 * 1024
  }
  // FLAC varies with source content; a conservative bound keeps quota checks
  // from accepting a job that cannot fit after encoding.
  return Math.ceil(inputSize * 1.15) + 256 * 1024
}

function isAbortError(error: unknown): boolean {
  return error instanceof LocalAudioMediaError && error.code === 'ABORTED'
}

function waitForWriterDrain(writer: WriteStream): Promise<void> {
  if (writer.destroyed) return Promise.reject(new Error('WRITE_STREAM_CLOSED'))
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writer.off('drain', onDrain)
      writer.off('error', onError)
      writer.off('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('WRITE_STREAM_CLOSED'))
    }
    writer.once('drain', onDrain)
    writer.once('error', onError)
    writer.once('close', onClose)
  })
}

function publicTask(task: TaskRecord): LocalAudioTask {
  const {
    roomId: _roomId,
    fileSize: _fileSize,
    audioQuality: _audioQuality,
    inputPath: _inputPath,
    partPath: _partPath,
    abortController: _abortController,
    requestDestroy: _requestDestroy,
    inputTimer: _inputTimer,
    retentionTimer: _retentionTimer,
    cleanupTimer: _cleanupTimer,
    cleanupPromise: _cleanupPromise,
    cleanupRetryCount: _cleanupRetryCount,
    failedOutputDir: _failedOutputDir,
    tempReservationHeld: _tempReservationHeld,
    finalReservationBytes: _finalReservationBytes,
    ...safe
  } = task
  return safe
}

function publicAsset(asset: AssetRecord, cover: string): LocalAudioAsset {
  const {
    roomId: _roomId,
    originalFileName: _originalFileName,
    primaryPath: _primaryPath,
    primaryMimeType: _primaryMimeType,
    primarySizeBytes: _primarySizeBytes,
    fallbackPath: _fallbackPath,
    fallbackSizeBytes: _fallbackSizeBytes,
    coverPath: _coverPath,
    pendingDelete: _pendingDelete,
    activeStreams: _activeStreams,
    activeStreamClosers: _activeStreamClosers,
    deleteRetryCount: _deleteRetryCount,
    deleteTimer: _deleteTimer,
    ...safe
  } = asset
  return { ...safe, cover }
}

export class LocalAudioService {
  readonly dataDir: string
  readonly assetsDir: string
  readonly tempDir: string
  readonly maxUploadBytes: number
  readonly roomQuotaBytes: number
  readonly serverQuotaBytes: number
  readonly tempQuotaBytes: number
  readonly minFreeBytes: number

  private readonly rooms = new Map<string, RoomIndex>()
  private readonly roomCleanupPromises = new Map<string, Promise<void>>()
  private readonly processLimit = pLimit(1)
  private readonly media: LocalAudioMedia
  private io: TypedServer | undefined
  private initialized = false
  private draining = false
  private tempReservedBytes = 0
  private finalReservedBytes = 0
  private finalBytes = 0

  constructor(options: LocalAudioServiceOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? config.localAudio.dataDir)
    this.assetsDir = path.join(this.dataDir, 'assets')
    this.tempDir = path.join(this.dataDir, 'tmp')
    this.maxUploadBytes = options.maxUploadBytes ?? config.localAudio.maxUploadBytes
    this.roomQuotaBytes = options.roomQuotaBytes ?? config.localAudio.roomQuotaBytes
    this.serverQuotaBytes = options.serverQuotaBytes ?? config.localAudio.serverQuotaBytes
    this.tempQuotaBytes = options.tempQuotaBytes ?? config.localAudio.tempQuotaBytes
    this.minFreeBytes = options.minFreeBytes ?? config.localAudio.minFreeBytes
    this.media =
      options.media ??
      createLocalAudioMedia({
        ffprobePath: config.localAudio.ffprobePath,
        ffmpegPath: config.localAudio.ffmpegPath,
        commandTimeoutMs: config.localAudio.ffmpegTimeoutMs,
        ffmpegThreads: config.localAudio.ffmpegThreads,
      })
    this.io = options.io
  }

  setIo(io: TypedServer): void {
    this.io = io
  }

  beginShutdown(): void {
    if (this.draining) return
    this.draining = true
    this.processLimit.clearQueue()
  }

  private assertAcceptingUploads(): void {
    if (this.draining) throw new Error('LOCAL_AUDIO_SHUTTING_DOWN')
  }

  private roomIndex(roomId: string): RoomIndex {
    let index = this.rooms.get(roomId)
    if (!index) {
      index = { assets: new Map(), tasks: new Map() }
      this.rooms.set(roomId, index)
    }
    return index
  }

  private async waitForRoomCleanup(roomId: string): Promise<void> {
    // A room may be recreated with the same ID while the previous asset
    // directory is still being removed. Wait through any chained cleanup
    // promises before allocating a new in-memory index or file path.
    for (;;) {
      const pending = this.roomCleanupPromises.get(roomId)
      if (!pending) return
      await pending
    }
  }

  private armInputIdleTimer(task: TaskRecord): void {
    if (task.inputTimer) clearTimeout(task.inputTimer)
    task.inputTimer = setTimeout(() => {
      if (task.stage === 'waiting-upload' || task.stage === 'receiving') {
        void this.cancelTask(
          task.roomId,
          task.taskId,
          { id: task.uploadedByUserId, nickname: task.uploadedByNickname, role: 'member' },
          true,
        ).catch((error: unknown) => {
          logger.error('Failed to cancel idle local audio upload', error, {
            roomId: task.roomId,
            taskId: task.taskId,
          })
        })
      }
    }, INPUT_IDLE_TIMEOUT_MS)
    task.inputTimer.unref?.()
  }

  private emitTask(task: TaskRecord): void {
    this.io?.to(task.roomId).emit(EVENTS.LOCAL_AUDIO_TASK_UPDATED, publicTask(task))
  }

  private emitAsset(asset: AssetRecord): void {
    this.io?.to(asset.roomId).emit(EVENTS.LOCAL_AUDIO_ASSET_UPDATED, this.toPublicAsset(asset))
  }

  private emitQueueFullForUploader(task: TaskRecord): void {
    const socketId = roomRepo.getSocketIdForUser(task.roomId, task.uploadedByUserId)
    if (!socketId) return
    this.io?.to(socketId).emit(EVENTS.ROOM_ERROR, {
      code: ERROR_CODE.QUEUE_FULL,
      message: '本地音频上传成功，但播放列表已满，未自动加入',
    })
  }

  private toPublicAsset(asset: AssetRecord): LocalAudioAsset {
    return publicAsset(asset, asset.coverPath ? this.assetUrl(asset.roomId, asset.assetId, 'cover') : '')
  }

  private socketsByRole(roomId: string): { privileged: string[]; members: string[] } {
    const privileged: string[] = []
    const members: string[] = []
    const room = roomRepo.get(roomId)
    if (!room) return { privileged, members }
    for (const user of room.users) {
      const socketId = roomRepo.getSocketIdForUser(roomId, user.id)
      if (!socketId) continue
      if (user.role === 'owner' || user.role === 'admin') privileged.push(socketId)
      else members.push(socketId)
    }
    return { privileged, members }
  }

  private broadcastRoomState(roomId: string): void {
    if (!this.io) return
    const room = roomRepo.get(roomId)
    if (!room) return
    const { privileged, members } = this.socketsByRole(roomId)
    if (privileged.length > 0) this.io.to(privileged).emit(EVENTS.ROOM_STATE, toPublicRoomState(room))
    if (members.length > 0) this.io.to(members).emit(EVENTS.ROOM_STATE, toPublicRoomStateForMember(room))
  }

  private broadcastDefaultQueueDelta(roomId: string, delta: DefaultQueueDelta): void {
    if (!this.io) return
    const { privileged } = this.socketsByRole(roomId)
    if (privileged.length > 0) {
      this.io.to(privileged).emit(EVENTS.DEFAULT_QUEUE_DELTA, delta)
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const root = path.resolve(this.dataDir)
    if (root === path.parse(root).root || root.length < 8) {
      throw new Error(`Refusing to use unsafe local audio data directory: ${root}`)
    }
    // Room state is in memory, so every file from a previous process has no
    // owner and must be removed before accepting new uploads.
    for (const directory of [this.assetsDir, this.tempDir]) {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true, mode: 0o750 })
    }
    this.initialized = true
    logger.info(`Local audio storage initialized at ${root}`)
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }

  private async freeBytes(): Promise<number> {
    try {
      const info = await statfs(this.dataDir)
      return Number(info.bavail) * Number(info.bsize)
    } catch {
      // Quota enforcement must fail closed if the filesystem cannot be
      // inspected; otherwise an unavailable statfs implementation could turn
      // the disk floor into an unlimited upload path.
      return 0
    }
  }

  private roomBytes(index: RoomIndex): number {
    let total = 0
    for (const asset of index.assets.values()) total += asset.sizeBytes
    return total
  }

  private roomReservedBytes(index: RoomIndex, excludeTask?: TaskRecord): number {
    let total = 0
    for (const task of index.tasks.values()) {
      if (task !== excludeTask) total += task.finalReservationBytes
    }
    return total
  }

  /** Temp reservations not yet reflected in statfs free-space accounting. */
  private unwrittenTempReservationBytes(): number {
    let total = 0
    for (const index of this.rooms.values()) {
      for (const task of index.tasks.values()) {
        if (!task.tempReservationHeld) continue
        const written = Math.max(0, Math.min(task.fileSize, task.receivedBytes ?? 0))
        total += Math.max(0, task.fileSize - written)
      }
    }
    return total
  }

  private getTask(roomId: string, taskId: string): TaskRecord | undefined {
    return this.rooms.get(roomId)?.tasks.get(taskId)
  }

  private tracksTask(task: TaskRecord): boolean {
    return this.rooms.get(task.roomId)?.tasks.get(task.taskId) === task
  }

  private taskCleanupComplete(task: TaskRecord): boolean {
    return !task.tempReservationHeld && task.finalReservationBytes <= 0 && !task.failedOutputDir
  }

  /** Check all in-memory reservations again immediately before creating a task. */
  private assertTaskCapacity(index: RoomIndex, userId: string, fileSize: number): void {
    this.trimTasks(index, MAX_TASKS_PER_ROOM - 1)
    if (index.tasks.size >= MAX_TASKS_PER_ROOM) throw new Error('LOCAL_AUDIO_TASK_LIMIT')
    for (const roomIndex of this.rooms.values()) {
      for (const task of roomIndex.tasks.values()) {
        if (task.uploadedByUserId === userId && isInputStage(task.stage)) throw new Error('LOCAL_AUDIO_BUSY')
      }
    }
    if (this.tempReservedBytes + fileSize > this.tempQuotaBytes) throw new Error('LOCAL_AUDIO_QUOTA_EXCEEDED')
    // A processing task can conservatively reserve its entire aggregate output
    // ceiling. That reservation must protect disk/quota accounting if cleanup
    // later fails, but it must not prevent another raw upload from being
    // received while the single media worker is busy. Only committed assets
    // make task creation impossible; processing will re-check reservations
    // before it starts.
    if (this.roomBytes(index) >= this.roomQuotaBytes || this.finalBytes >= this.serverQuotaBytes) {
      throw new Error('LOCAL_AUDIO_QUOTA_EXCEEDED')
    }
  }

  getAsset(roomId: string, assetId: string): AssetRecord | undefined {
    return this.rooms.get(roomId)?.assets.get(assetId)
  }

  snapshot(roomId: string): LocalAudioState {
    const index = this.rooms.get(roomId) ?? { assets: new Map(), tasks: new Map() }
    return {
      assets: Array.from(index.assets.values())
        .filter((asset) => !asset.pendingDelete)
        .map((asset) => this.toPublicAsset(asset)),
      tasks: Array.from(index.tasks.values()).map(publicTask),
      usage: {
        maxUploadBytes: this.maxUploadBytes,
        roomBytes: this.roomBytes(index),
        roomLimitBytes: this.roomQuotaBytes,
        serverBytes: this.finalBytes,
        serverLimitBytes: this.serverQuotaBytes,
        tempBytes: this.tempReservedBytes,
        tempLimitBytes: this.tempQuotaBytes,
      },
    }
  }

  emitSnapshot(roomId: string, socket?: TypedSocket): void {
    const snapshot = this.snapshot(roomId)
    if (socket) socket.emit(EVENTS.LOCAL_AUDIO_STATE, snapshot)
    else this.io?.to(roomId).emit(EVENTS.LOCAL_AUDIO_STATE, snapshot)
  }

  private removeTask(index: RoomIndex, task: TaskRecord): void {
    if (task.inputTimer) clearTimeout(task.inputTimer)
    if (task.retentionTimer) clearTimeout(task.retentionTimer)
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
    task.inputTimer = undefined
    task.retentionTimer = undefined
    task.cleanupTimer = undefined
    if (!index.tasks.delete(task.taskId)) return
    this.io?.to(task.roomId).emit(EVENTS.LOCAL_AUDIO_TASK_REMOVED, { taskId: task.taskId })
  }

  private scheduleTaskRemoval(task: TaskRecord): void {
    if (!this.taskCleanupComplete(task)) return
    if (task.retentionTimer) clearTimeout(task.retentionTimer)
    task.retentionTimer = setTimeout(() => {
      const index = this.rooms.get(task.roomId)
      if (index?.tasks.get(task.taskId) === task && !isActiveStage(task.stage) && this.taskCleanupComplete(task)) {
        this.removeTask(index, task)
      }
    }, TASK_RETENTION_MS)
    task.retentionTimer.unref?.()
  }

  private trimTasks(index: RoomIndex, targetSize = MAX_TASKS_PER_ROOM): void {
    if (index.tasks.size <= targetSize) return
    const terminal = Array.from(index.tasks.values())
      .filter((task) => !isActiveStage(task.stage) && this.taskCleanupComplete(task))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    while (index.tasks.size > targetSize && terminal.length > 0) {
      const task = terminal.shift()!
      this.removeTask(index, task)
    }
  }

  async createTask(roomId: string, actor: LocalAudioTaskActor, input: CreateTaskInput): Promise<LocalAudioTask> {
    this.assertAcceptingUploads()
    await this.ensureInitialized()
    this.assertAcceptingUploads()
    await this.waitForRoomCleanup(roomId)
    this.assertAcceptingUploads()
    const room = roomRepo.get(roomId)
    if (!room || !room.users.some((user) => user.id === actor.id)) throw new Error('ROOM_NOT_FOUND')
    const fileName = safeFileName(input.fileName)
    const fileSize = Number(input.fileSize)
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > this.maxUploadBytes) {
      throw new Error('LOCAL_AUDIO_INVALID_SIZE')
    }

    const index = this.roomIndex(roomId)
    this.assertTaskCapacity(index, actor.id, fileSize)
    const freeBytes = await this.freeBytes()
    this.assertAcceptingUploads()

    // The disk check yields to the event loop. Re-read room ownership and all
    // reservations before committing this task so concurrent requests cannot
    // pass the same preflight snapshot (or recreate a detached room index).
    const currentRoom = roomRepo.get(roomId)
    if (!currentRoom || !currentRoom.users.some((user) => user.id === actor.id) || this.rooms.get(roomId) !== index) {
      throw new Error('ROOM_NOT_FOUND')
    }
    this.assertTaskCapacity(index, actor.id, fileSize)
    // Conservatively count in-flight final output as well as unwritten input.
    // statfs may already reflect part of an FFmpeg output, so this can double
    // count some bytes, but avoids letting a new raw upload and a running
    // transcode consume the same remaining disk budget.
    if (freeBytes - this.minFreeBytes < this.unwrittenTempReservationBytes() + this.finalReservedBytes + fileSize) {
      throw new Error('LOCAL_AUDIO_DISK_LOW')
    }

    const taskId = nanoid(16)
    const partPath = path.join(this.tempDir, `${taskId}.part`)
    const inputPath = path.join(this.tempDir, `${taskId}.input`)
    const now = Date.now()
    const task: TaskRecord = {
      taskId,
      roomId,
      originalFileName: fileName,
      uploadedByUserId: actor.id,
      uploadedByNickname: actor.nickname,
      addToQueue: input.addToQueue !== false,
      stage: 'waiting-upload',
      progress: 0,
      receivedBytes: 0,
      totalBytes: fileSize,
      createdAt: now,
      updatedAt: now,
      fileSize,
      audioQuality: currentRoom.audioQuality,
      inputPath,
      partPath,
      abortController: new AbortController(),
      cleanupRetryCount: 0,
      tempReservationHeld: true,
      finalReservationBytes: 0,
    }
    this.tempReservedBytes += fileSize
    index.tasks.set(taskId, task)
    this.armInputIdleTimer(task)
    this.emitTask(task)
    this.emitSnapshot(roomId)
    this.trimTasks(index)
    return publicTask(task)
  }

  private updateTask(task: TaskRecord, patch: Partial<LocalAudioTask>): void {
    Object.assign(task, patch, { updatedAt: Date.now() })
    this.emitTask(task)
  }

  private async removeTaskTempFiles(task: TaskRecord): Promise<void> {
    const results = await Promise.allSettled([rm(task.partPath, { force: true }), rm(task.inputPath, { force: true })])
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  private async removeTaskOutputDirectory(outputDir: string): Promise<void> {
    await rm(outputDir, { recursive: true, force: true })
  }

  private async attemptTaskFileCleanup(task: TaskRecord): Promise<boolean> {
    if (!this.tracksTask(task)) return false
    let failed = false

    if (task.failedOutputDir) {
      try {
        await this.removeTaskOutputDirectory(task.failedOutputDir)
        if (!this.tracksTask(task)) return false
        task.failedOutputDir = undefined
        this.releaseFinalReservation(task)
      } catch (error) {
        failed = true
        logger.error('Failed to delete local audio task output; retrying', error, {
          roomId: task.roomId,
          taskId: task.taskId,
        })
      }
    }

    if (task.tempReservationHeld) {
      try {
        await this.removeTaskTempFiles(task)
        if (!this.tracksTask(task)) return false
        task.tempReservationHeld = false
        this.tempReservedBytes = Math.max(0, this.tempReservedBytes - task.fileSize)
        this.emitSnapshot(task.roomId)
      } catch (error) {
        failed = true
        logger.error('Failed to delete local audio task input; retrying', error, {
          roomId: task.roomId,
          taskId: task.taskId,
        })
      }
    }

    return !failed && this.taskCleanupComplete(task)
  }

  private runTaskFileCleanup(task: TaskRecord): Promise<boolean> {
    if (task.cleanupPromise) return task.cleanupPromise
    const cleanup = this.attemptTaskFileCleanup(task)
    task.cleanupPromise = cleanup
    const clear = () => {
      if (task.cleanupPromise === cleanup) task.cleanupPromise = undefined
    }
    void cleanup.then(clear, clear)
    return cleanup
  }

  private scheduleTaskCleanupRetry(task: TaskRecord): void {
    if (!this.tracksTask(task) || task.cleanupTimer) return
    task.cleanupRetryCount += 1
    const retryInMs = this.deleteRetryDelay(task.cleanupRetryCount)
    task.cleanupTimer = setTimeout(() => {
      task.cleanupTimer = undefined
      void this.cleanupTaskFilesOrSchedule(task).catch((error: unknown) => {
        logger.error('Unexpected local audio task cleanup failure; retrying', error, {
          roomId: task.roomId,
          taskId: task.taskId,
        })
        this.scheduleTaskCleanupRetry(task)
      })
    }, retryInMs)
    task.cleanupTimer.unref?.()
  }

  private async cleanupTaskFilesOrSchedule(task: TaskRecord): Promise<void> {
    const cleaned = await this.runTaskFileCleanup(task)
    if (!this.tracksTask(task)) return
    if (cleaned) {
      task.cleanupRetryCount = 0
      if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
      task.cleanupTimer = undefined
      this.scheduleTaskRemoval(task)
      return
    }
    this.scheduleTaskCleanupRetry(task)
  }

  private async failTask(task: TaskRecord, errorCode: string, errorMessage: string, cancelled = false): Promise<void> {
    const active = isActiveStage(task.stage)
    if (!active && task.stage !== 'failed' && task.stage !== 'cancelled') return
    const index = this.rooms.get(task.roomId)
    if (task.inputTimer) clearTimeout(task.inputTimer)
    task.inputTimer = undefined
    if (active) {
      this.updateTask(task, {
        stage: cancelled ? 'cancelled' : 'failed',
        progress: cancelled ? task.progress : undefined,
        errorCode,
        errorMessage,
      })
    }
    await this.cleanupTaskFilesOrSchedule(task)
    if (index && this.rooms.get(task.roomId) === index && index.tasks.get(task.taskId) === task) {
      this.trimTasks(index)
    }
  }

  /**
   * Receive a raw request body into a private .part file. The route performs
   * identity checks before calling this method; this method still verifies the
   * task owner and exact Content-Length to keep the storage boundary strict.
   */
  async receiveUpload(input: ReceiveUploadInput): Promise<LocalAudioTask> {
    this.assertAcceptingUploads()
    await this.ensureInitialized()
    this.assertAcceptingUploads()
    const task = this.getTask(input.roomId, input.taskId)
    if (!task) throw new Error('LOCAL_AUDIO_NOT_FOUND')
    if (task.uploadedByUserId !== input.actor.id) throw new Error('NO_PERMISSION')
    if (task.stage !== 'waiting-upload') throw new Error('LOCAL_AUDIO_INVALID_STATE')
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength !== task.fileSize) {
      await this.failTask(task, 'INVALID_CONTENT_LENGTH', '上传大小与预检不一致')
      throw new Error('LOCAL_AUDIO_INVALID_SIZE')
    }

    if (task.inputTimer) clearTimeout(task.inputTimer)
    task.inputTimer = undefined
    const destroyRequest = (error?: Error) => {
      try {
        input.request.destroy?.(error)
      } catch {
        // Best effort: the request may already be closed.
      }
    }
    task.requestDestroy = () => destroyRequest()
    task.abortController = new AbortController()
    this.updateTask(task, { stage: 'receiving', progress: 0, receivedBytes: 0, totalBytes: task.fileSize })
    this.armInputIdleTimer(task)

    let writer: WriteStream | undefined
    let writerFailure: Error | undefined
    let onWriterError: ((error: Error) => void) | undefined
    let onWriterClose: (() => void) | undefined
    let received = 0
    let lastEmitAt = 0
    const detachWriterListeners = () => {
      if (!writer) return
      if (onWriterError) writer.off('error', onWriterError)
      if (onWriterClose) writer.off('close', onWriterClose)
      onWriterError = undefined
      onWriterClose = undefined
    }
    try {
      await rm(task.partPath, { force: true })
      writer = createWriteStream(task.partPath, { flags: 'wx', mode: 0o600 })
      onWriterError = (error: Error) => {
        writerFailure = error
        destroyRequest(error)
      }
      onWriterClose = () => {
        if (!writer?.writableFinished && !writerFailure) {
          writerFailure = new Error('WRITE_STREAM_CLOSED')
          destroyRequest(writerFailure)
        }
      }
      writer.on('error', onWriterError)
      writer.on('close', onWriterClose)
      const writeChunk = async (chunk: Buffer): Promise<void> => {
        if (task.abortController.signal.aborted) throw new Error('ABORTED')
        if (writerFailure) throw writerFailure
        this.armInputIdleTimer(task)
        received += chunk.length
        if (received > task.fileSize) throw new Error('TOO_LARGE')
        if (!writer!.write(chunk)) await waitForWriterDrain(writer!)
        if (writerFailure) throw writerFailure
        const now = Date.now()
        if (now - lastEmitAt >= 200 || received === task.fileSize) {
          lastEmitAt = now
          this.updateTask(task, {
            receivedBytes: received,
            progress: clampProgress((received / task.fileSize) * RECEIVING_MAX_PROGRESS),
          })
        }
      }

      for await (const chunk of input.request as AsyncIterable<Buffer | string>) {
        await writeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      if (received !== task.fileSize) throw new Error('INCOMPLETE')
      writer.end()
      await finished(writer)
      if (writerFailure) throw writerFailure
      await rename(task.partPath, task.inputPath)
      if (task.inputTimer) clearTimeout(task.inputTimer)
      task.inputTimer = undefined
      detachWriterListeners()
      writer = undefined
      task.requestDestroy = undefined
      this.updateTask(task, { stage: 'queued', progress: RECEIVING_MAX_PROGRESS, receivedBytes: received })
      void this.processTask(task).catch((error: unknown) => {
        // The processing body handles expected media/quota failures itself.
        // Keep an unexpected boundary failure from becoming an unhandled
        // rejection after the upload request has already returned.
        logger.error('Local audio task failed outside processing guard', error, {
          roomId: task.roomId,
          taskId: task.taskId,
        })
      })
      return publicTask(task)
    } catch (error) {
      detachWriterListeners()
      const writerClosed = writer ? finished(writer).catch(() => undefined) : Promise.resolve()
      writer?.destroy()
      await writerClosed
      task.requestDestroy = undefined
      const failure = writerFailure ?? error
      const message = failure instanceof Error ? failure.message : '上传连接中断'
      const cancelled = message === 'ABORTED' || task.abortController.signal.aborted
      await this.failTask(
        task,
        cancelled ? 'CANCELLED' : 'UPLOAD_INTERRUPTED',
        cancelled ? '上传已取消' : '上传连接中断',
        cancelled,
      )
      throw failure
    }
  }

  private async reserveFinalBytes(task: TaskRecord, estimate: number): Promise<number> {
    const index = this.rooms.get(task.roomId)
    if (!index || index.tasks.get(task.taskId) !== task || !roomRepo.get(task.roomId)) {
      throw new LocalAudioMediaError('ABORTED', '房间已销毁，媒体处理已取消')
    }
    const freeBytes = await this.freeBytes()
    // `freeBytes()` yields to the event loop. A room cleanup can therefore
    // happen after the initial ownership check but before reservation commit;
    // re-check immediately before calculating and mutating global accounting.
    if (
      this.rooms.get(task.roomId) !== index ||
      index.tasks.get(task.taskId) !== task ||
      !roomRepo.get(task.roomId) ||
      task.abortController.signal.aborted ||
      !isActiveStage(task.stage)
    ) {
      throw new LocalAudioMediaError('ABORTED', '房间已销毁，媒体处理已取消')
    }

    const roomRemaining = this.roomQuotaBytes - this.roomBytes(index) - this.roomReservedBytes(index, task)
    const serverRemaining =
      this.serverQuotaBytes - this.finalBytes - Math.max(0, this.finalReservedBytes - task.finalReservationBytes)
    const diskRemaining = freeBytes - this.minFreeBytes - this.unwrittenTempReservationBytes()
    if (estimate > roomRemaining || estimate > serverRemaining) throw new Error('LOCAL_AUDIO_QUOTA_EXCEEDED')
    if (estimate > diskRemaining) throw new Error('LOCAL_AUDIO_DISK_LOW')

    const aggregateMaxOutputBytes = Math.floor(Math.min(roomRemaining, serverRemaining, diskRemaining))
    if (!Number.isSafeInteger(aggregateMaxOutputBytes) || aggregateMaxOutputBytes <= 0) {
      if (diskRemaining <= 0) throw new Error('LOCAL_AUDIO_DISK_LOW')
      throw new Error('LOCAL_AUDIO_QUOTA_EXCEEDED')
    }
    // Reserve the full aggregate hard ceiling. If processing fails and the
    // output directory cannot be removed immediately, this remains a safe
    // upper bound for the uncommitted physical bytes until cleanup succeeds.
    // Task creation deliberately ignores final reservations for server quota,
    // while its disk preflight includes them, so another input may still be
    // received without oversubscribing the filesystem.
    task.finalReservationBytes = aggregateMaxOutputBytes
    this.finalReservedBytes += aggregateMaxOutputBytes
    return aggregateMaxOutputBytes
  }

  private releaseFinalReservation(task: TaskRecord): void {
    if (task.finalReservationBytes <= 0) return
    this.finalReservedBytes = Math.max(0, this.finalReservedBytes - task.finalReservationBytes)
    task.finalReservationBytes = 0
  }

  private async processTask(task: TaskRecord): Promise<void> {
    await this.processLimit(async () => {
      if (
        task.stage !== 'queued' ||
        this.rooms.get(task.roomId)?.tasks.get(task.taskId) !== task ||
        !roomRepo.get(task.roomId)
      )
        return
      const signal = task.abortController.signal
      const assetId = nanoid(16)
      const assetDir = path.join(this.assetsDir, task.roomId, assetId)
      let primaryPath: string | undefined
      let fallbackPath: string | undefined
      let coverPath: string | undefined
      let committed = false
      task.failedOutputDir = assetDir
      try {
        this.updateTask(task, { stage: 'probing', progress: RECEIVING_MAX_PROGRESS })
        const metadata = await this.media.probeFile(task.inputPath, {
          originalName: task.originalFileName,
          sizeBytes: task.fileSize,
          signal,
          timeoutMs: config.localAudio.ffprobeTimeoutMs,
        })
        const profile = getLocalAudioQualityProfile(metadata, task.audioQuality)
        const estimate = outputEstimateBytes(metadata, profile, task.fileSize)
        const aggregateMaxOutputBytes = await this.reserveFinalBytes(task, estimate)
        const coverReservation = metadata.hasEmbeddedCover ? LOCAL_AUDIO_MEDIA_LIMITS.coverMaxBytes : 0
        const audioOutputBudget = aggregateMaxOutputBytes - coverReservation
        if (audioOutputBudget <= 0) throw new Error('LOCAL_AUDIO_QUOTA_EXCEEDED')

        await mkdir(assetDir, { recursive: true, mode: 0o750 })
        primaryPath = path.join(assetDir, `primary.${profile.primary.extension}`)
        fallbackPath = profile.fallback ? path.join(assetDir, `fallback.${profile.fallback.extension}`) : undefined
        coverPath = path.join(assetDir, 'cover.jpg')

        this.updateTask(task, { stage: 'transcoding', progress: TRANSCODING_START_PROGRESS })
        await this.media.transcode({
          inputPath: task.inputPath,
          outputPath: primaryPath,
          profile: profile.primary,
          signal,
          timeoutMs: config.localAudio.ffmpegTimeoutMs,
          maxOutputBytes: audioOutputBudget,
        })
        const primaryStat = await stat(primaryPath)
        this.updateTask(task, { progress: profile.fallback ? 0.97 : 0.98 })
        let fallbackSize = 0
        if (profile.fallback && fallbackPath) {
          const fallbackBudget = audioOutputBudget - primaryStat.size
          if (fallbackBudget <= 0) {
            throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
          }
          await this.media.transcode({
            inputPath: task.inputPath,
            outputPath: fallbackPath,
            profile: profile.fallback,
            signal,
            timeoutMs: config.localAudio.ffmpegTimeoutMs,
            maxOutputBytes: fallbackBudget,
          })
          fallbackSize = (await stat(fallbackPath)).size
          this.updateTask(task, { progress: 0.98 })
        }

        let coverSize = 0
        if (metadata.hasEmbeddedCover) {
          const coverBudget = Math.min(
            LOCAL_AUDIO_MEDIA_LIMITS.coverMaxBytes,
            aggregateMaxOutputBytes - primaryStat.size - fallbackSize,
          )
          if (coverBudget <= 0) {
            throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '音频与封面超过空间限制')
          }
          const cover = await this.media.extractCover({
            inputPath: task.inputPath,
            outputPath: coverPath,
            hasEmbeddedCover: true,
            signal,
            timeoutMs: config.localAudio.ffmpegTimeoutMs,
            maxBytes: coverBudget,
          })
          if (!cover.path) coverPath = undefined
          else coverSize = cover.sizeBytes
        } else {
          coverPath = undefined
        }

        if (signal.aborted || (task.stage as LocalAudioTask['stage']) !== 'transcoding') {
          throw new LocalAudioMediaError('ABORTED', '媒体处理已取消')
        }

        const actualSize = primaryStat.size + fallbackSize + coverSize
        if (actualSize > aggregateMaxOutputBytes) {
          throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '处理后的本地音频超过空间限制')
        }
        // Room deletion can race with the final filesystem/stat step. Never
        // recreate an index or commit an asset for a room that no longer owns
        // this task.
        const index = this.rooms.get(task.roomId)
        if (
          !index ||
          index.tasks.get(task.taskId) !== task ||
          !roomRepo.get(task.roomId) ||
          signal.aborted ||
          (task.stage as LocalAudioTask['stage']) !== 'transcoding'
        ) {
          throw new LocalAudioMediaError('ABORTED', '房间已销毁，媒体处理已取消')
        }
        const roomActual = this.roomBytes(index)
        const roomReservedByOthers = this.roomReservedBytes(index, task)
        const serverReservedByOthers = Math.max(0, this.finalReservedBytes - task.finalReservationBytes)
        if (
          roomActual + roomReservedByOthers + actualSize > this.roomQuotaBytes ||
          this.finalBytes + serverReservedByOthers + actualSize > this.serverQuotaBytes
        ) {
          throw new Error('LOCAL_AUDIO_QUOTA_EXCEEDED')
        }
        const freeBytes = await this.freeBytes()
        if (freeBytes - this.minFreeBytes < this.unwrittenTempReservationBytes()) {
          throw new Error('LOCAL_AUDIO_DISK_LOW')
        }
        // The actual-size disk check also yields. Revalidate ownership after
        // it so cleanup cannot detach the index and let this task commit into
        // a directory belonging to a newly recreated room.
        if (
          this.rooms.get(task.roomId) !== index ||
          index.tasks.get(task.taskId) !== task ||
          !roomRepo.get(task.roomId) ||
          signal.aborted ||
          (task.stage as LocalAudioTask['stage']) !== 'transcoding'
        ) {
          throw new LocalAudioMediaError('ABORTED', '房间已销毁，媒体处理已取消')
        }

        const now = Date.now()
        const asset: AssetRecord = {
          roomId: task.roomId,
          assetId,
          title: metadata.title,
          artist: metadata.artist,
          album: metadata.album,
          duration: metadata.durationSeconds,
          cover: coverPath ? this.assetUrl(task.roomId, assetId, 'cover') : '',
          uploadedByUserId: task.uploadedByUserId,
          uploadedByNickname: task.uploadedByNickname,
          createdAt: now,
          sizeBytes: actualSize,
          audioQuality: task.audioQuality,
          primaryFormat: profile.primary.container,
          hasFallback: Boolean(profile.fallback && fallbackPath),
          codec: profile.primary.codec,
          bitrate: profile.primary.bitrateKbps,
          status: 'ready',
          originalFileName: task.originalFileName,
          primaryPath,
          primaryMimeType: profile.primary.mimeType,
          primarySizeBytes: primaryStat.size,
          fallbackPath: profile.fallback && fallbackPath ? fallbackPath : undefined,
          fallbackSizeBytes: fallbackSize || undefined,
          coverPath,
          pendingDelete: false,
          activeStreams: 0,
          activeStreamClosers: new Set(),
          deleteRetryCount: 0,
        }
        index.assets.set(assetId, asset)
        this.finalBytes += actualSize
        this.releaseFinalReservation(task)
        task.failedOutputDir = undefined
        this.updateTask(task, { stage: 'ready', progress: 1, assetId })
        this.emitAsset(asset)
        this.emitSnapshot(task.roomId)
        committed = true
        await this.cleanupTaskFilesOrSchedule(task)
        if (task.addToQueue) {
          const added = await this.addAssetToQueue(task.roomId, assetId, task.uploadedByNickname, false)
          if (!added && roomRepo.get(task.roomId)) this.emitQueueFullForUploader(task)
        }
      } catch (error) {
        if (committed) {
          logger.error('Local audio asset committed but post-processing integration failed', error, {
            roomId: task.roomId,
            taskId: task.taskId,
            assetId,
          })
          return
        }
        const cancelled = task.abortController.signal.aborted || isAbortError(error)
        const code = error instanceof Error ? error.message : ''
        const mediaCode = error instanceof LocalAudioMediaError ? error.code : undefined
        const normalizedMediaCode = mediaCode === 'OUTPUT_TOO_LARGE' ? 'LOCAL_AUDIO_QUOTA_EXCEEDED' : mediaCode
        await this.failTask(
          task,
          cancelled
            ? 'CANCELLED'
            : (normalizedMediaCode ??
                (code === 'LOCAL_AUDIO_QUOTA_EXCEEDED' || code === 'LOCAL_AUDIO_DISK_LOW'
                  ? code
                  : 'PROCESSING_FAILED')),
          cancelled ? '处理已取消' : this.publicErrorMessage(error),
          cancelled,
        )
      }
    })
  }

  private publicErrorMessage(error: unknown): string {
    if (error instanceof LocalAudioMediaError) {
      if (error.code === 'INVALID_MEDIA') return error.message
      if (error.code === 'TIMEOUT') return '媒体处理超时'
      if (error.code === 'COMMAND_NOT_FOUND') return '服务器未安装音频处理组件'
      return error.message
    }
    if (error instanceof Error && error.message === 'LOCAL_AUDIO_QUOTA_EXCEEDED') return '房间或服务器存储配额不足'
    if (error instanceof Error && error.message === 'LOCAL_AUDIO_DISK_LOW') return '服务器可用磁盘空间不足'
    return '音频处理失败，请重新上传'
  }

  private assetUrl(roomId: string, assetId: string, variant: LocalAudioAccessVariant, expiresAt?: number): string {
    const token =
      expiresAt !== undefined
        ? issueLocalAudioAccessTokenAt(roomId, assetId, variant, expiresAt)
        : issueLocalAudioAccessTokenAt(roomId, assetId, variant, Date.now() + config.localAudio.accessTokenTtlMs)
    const endpoint = variant === 'cover' ? 'cover' : variant === 'fallback' ? 'fallback' : 'stream'
    return `/api/rooms/${encodeURIComponent(roomId)}/local-audio/assets/${encodeURIComponent(assetId)}/${endpoint}?token=${encodeURIComponent(token)}`
  }

  buildTrack(roomId: string, assetId: string, requestedBy?: string, allowPendingCurrent = false): Track | null {
    const asset = this.getAsset(roomId, assetId)
    const room = roomRepo.get(roomId)
    const isCurrentPending = allowPendingCurrent && room?.currentTrack?.assetId === assetId
    if (!asset || (asset.pendingDelete && !isCurrentPending) || (asset.status !== 'ready' && !isCurrentPending))
      return null
    const accessExpiresAt = Date.now() + config.localAudio.accessTokenTtlMs
    return {
      id: nanoid(),
      title: asset.title,
      artist: asset.artist,
      album: asset.album,
      duration: asset.duration,
      cover: asset.coverPath ? this.assetUrl(roomId, assetId, 'cover', accessExpiresAt) : '',
      source: 'local',
      sourceId: assetId,
      urlId: assetId,
      assetId,
      streamUrl: this.assetUrl(roomId, assetId, 'primary', accessExpiresAt),
      fallbackStreamUrl: asset.fallbackPath ? this.assetUrl(roomId, assetId, 'fallback', accessExpiresAt) : undefined,
      localAudioAccessExpiresAt: accessExpiresAt,
      requestedBy,
    }
  }

  refreshTrack(roomId: string, track: Track, allowPendingCurrent = false): Track | null {
    if (track.source !== 'local' || !track.assetId) return null
    const refreshed = this.buildTrack(roomId, track.assetId, track.requestedBy, allowPendingCurrent)
    if (!refreshed) return null
    return { ...refreshed, id: track.id }
  }

  async addAssetToQueue(
    roomId: string,
    assetId: string,
    requestedBy: string,
    insertAfterCurrent: boolean,
  ): Promise<Track | null> {
    const track = this.buildTrack(roomId, assetId, requestedBy)
    const room = roomRepo.get(roomId)
    if (!track || !room) return null
    const atIndex = insertAfterCurrent ? queueService.insertAfterCurrent(roomId, track) : room.queue.length
    if (insertAfterCurrent && atIndex < 0) return null
    if (!insertAfterCurrent && !queueService.addTrack(roomId, track)) return null
    this.io?.to(roomId).emit(EVENTS.QUEUE_UPDATED, {
      type: 'insert',
      tracks: [track],
      atIndex: insertAfterCurrent ? atIndex : room.queue.length - 1,
    })
    const message = chatService.createSystemMessage(roomId, `${requestedBy} 点了一首「${track.title}」`)
    this.io?.to(roomId).emit(EVENTS.CHAT_MESSAGE, message)
    if (this.io) await playerService.autoPlayIfEmpty(this.io, roomId, track)
    return track
  }

  addAssetToDefaultQueue(roomId: string, assetId: string, requestedBy: string): Track | null {
    const track = this.buildTrack(roomId, assetId, requestedBy)
    const room = roomRepo.get(roomId)
    if (!track || !room) return null
    if (room.defaultQueue.length >= LIMITS.DEFAULT_QUEUE_MAX_SIZE) return null
    const ref = toDefaultQueueRef(track)
    room.defaultQueue.push(ref)
    this.broadcastDefaultQueueDelta(roomId, { type: 'add', tracks: [ref] })
    return track
  }

  async cancelTask(roomId: string, taskId: string, actor: LocalAudioTaskActor, system = false): Promise<boolean> {
    const task = this.getTask(roomId, taskId)
    if (!task || !isActiveStage(task.stage)) return false
    const canCancel = system || task.uploadedByUserId === actor.id || actor.role === 'owner' || actor.role === 'admin'
    if (!canCancel) throw new Error('NO_PERMISSION')
    const stage = task.stage
    task.abortController.abort(new Error('cancelled'))
    task.requestDestroy?.()
    // Probe/transcode may still hold the input/output files. Their processing
    // catch performs cleanup only after the underlying command has settled.
    if (stage === 'probing' || stage === 'transcoding') {
      if (task.inputTimer) clearTimeout(task.inputTimer)
      task.inputTimer = undefined
      this.updateTask(task, {
        stage: 'cancelled',
        errorCode: 'CANCELLED',
        errorMessage: '任务已取消',
      })
      return true
    }
    await this.failTask(task, 'CANCELLED', '任务已取消', true)
    return true
  }

  cancelReceivingForUser(roomId: string, userId: string): void {
    const index = this.rooms.get(roomId)
    if (!index) return
    for (const task of index.tasks.values()) {
      if (task.uploadedByUserId === userId && (task.stage === 'waiting-upload' || task.stage === 'receiving')) {
        void this.cancelTask(
          task.roomId,
          task.taskId,
          { id: userId, nickname: task.uploadedByNickname, role: 'member' },
          true,
        ).catch((error: unknown) => {
          logger.error('Failed to cancel local audio upload after room leave', error, {
            roomId,
            taskId: task.taskId,
            userId,
          })
        })
      }
    }
  }

  updateAsset(
    roomId: string,
    assetId: string,
    actor: LocalAudioTaskActor,
    patch: { title?: string; artist?: string[]; album?: string },
  ): LocalAudioAsset {
    const asset = this.getAsset(roomId, assetId)
    if (!asset || asset.pendingDelete) throw new Error('LOCAL_AUDIO_NOT_FOUND')
    const canEdit = actor.role === 'owner' || actor.role === 'admin' || asset.uploadedByUserId === actor.id
    if (!canEdit) throw new Error('NO_PERMISSION')
    if (patch.title !== undefined) asset.title = safeMetadataText(patch.title, asset.title)
    if (patch.artist !== undefined) {
      const artist = patch.artist
        .map((value) => safeMetadataText(value, ''))
        .filter(Boolean)
        .slice(0, 20)
      if (artist.length === 0) throw new Error('LOCAL_AUDIO_INVALID')
      asset.artist = artist
    }
    if (patch.album !== undefined) asset.album = safeMetadataText(patch.album, '本地音乐')
    this.propagateAssetMetadata(roomId, asset)
    this.emitAsset(asset)
    return this.toPublicAsset(asset)
  }

  private propagateAssetMetadata(roomId: string, asset: AssetRecord): void {
    const room = roomRepo.get(roomId)
    if (!room) return
    const apply = (track: Track): Track =>
      track.assetId === asset.assetId
        ? { ...track, title: asset.title, artist: asset.artist, album: asset.album, duration: asset.duration }
        : track
    room.queue = room.queue.map(apply)
    room.defaultQueue = room.defaultQueue.map((ref) =>
      ref.assetId === asset.assetId ? { ...ref, title: asset.title, artist: asset.artist } : ref,
    )
    room.playedHistory = room.playedHistory.map((entry) => ({ ...entry, track: apply(entry.track) }))
    if (room.currentTrack) room.currentTrack = apply(room.currentTrack)
    this.broadcastRoomState(roomId)
  }

  async deleteAsset(
    roomId: string,
    assetId: string,
    actor: LocalAudioTaskActor,
    removeFromQueue = false,
  ): Promise<boolean> {
    const asset = this.getAsset(roomId, assetId)
    const room = roomRepo.get(roomId)
    if (!asset || !room) return false
    const canDelete = actor.role === 'owner' || actor.role === 'admin' || asset.uploadedByUserId === actor.id
    if (!canDelete) throw new Error('NO_PERMISSION')
    if (asset.pendingDelete) return true

    const current = room.currentTrack?.assetId === assetId ? room.currentTrack : null
    const currentIndex = current ? room.queue.findIndex((track) => track.id === current.id) : -1
    const removedIds: string[] = []
    room.queue = room.queue.filter((track) => {
      if (track.assetId !== assetId) return true
      if (current && track.id === current.id && !removeFromQueue) return true
      removedIds.push(track.id)
      return false
    })
    const removedRefs = room.defaultQueue.filter((ref) => ref.assetId === assetId)
    room.defaultQueue = room.defaultQueue.filter((ref) => ref.assetId !== assetId)
    if (removedRefs.length > 0) {
      this.broadcastDefaultQueueDelta(roomId, { type: 'remove', trackIds: removedRefs.map((ref) => ref.id) })
    }
    room.playedHistory = room.playedHistory.filter((entry) => entry.track.assetId !== assetId)
    for (const id of removedIds) {
      room.trackLikes.delete(id)
      room.trackLikeTimestamps.delete(id)
    }
    if (removedIds.length > 0) this.io?.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: removedIds })
    this.io?.to(roomId).emit(EVENTS.PLAYED_HISTORY_UPDATED, { playedHistory: room.playedHistory })

    asset.pendingDelete = true
    asset.status = 'pending-delete'
    this.io?.to(roomId).emit(EVENTS.LOCAL_AUDIO_ASSET_REMOVED, { assetId })

    // Install cleanup before advancing playback so an unexpected player
    // failure cannot leave a hidden pending asset without a deletion timer.
    this.schedulePendingDeletion(asset, current && !removeFromQueue ? DELETE_RETRY_BASE_MS : 0)

    if (current && removeFromQueue && this.io) {
      try {
        await playerService.playNextTrackInRoom(this.io, roomId, room.playMode, {
          skipDebounce: true,
          previousIndex: Math.max(0, currentIndex),
          currentAlreadyRemoved: true,
          skipHistory: true,
          stopBeforeResolve: true,
        })
      } finally {
        // Re-check immediately after the synchronized switch (or a failure)
        // instead of waiting for the earlier polling timer.
        this.schedulePendingDeletion(asset, 0)
      }
    }

    return true
  }

  private tracksAsset(asset: AssetRecord): boolean {
    return this.rooms.get(asset.roomId)?.assets.get(asset.assetId) === asset
  }

  private closeActiveStreams(asset: AssetRecord): void {
    for (const closeStream of Array.from(asset.activeStreamClosers)) {
      try {
        closeStream()
      } catch (error) {
        logger.warn('Failed to close a local audio stream', {
          roomId: asset.roomId,
          assetId: asset.assetId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private deleteRetryDelay(attempt: number): number {
    return Math.min(DELETE_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempt - 1), 6), DELETE_RETRY_MAX_MS)
  }

  private schedulePendingDeletion(asset: AssetRecord, delayMs = DELETE_RETRY_BASE_MS): void {
    if (!this.tracksAsset(asset)) return
    if (asset.deleteTimer) clearTimeout(asset.deleteTimer)
    asset.deleteTimer = setTimeout(
      () => {
        asset.deleteTimer = undefined
        void this.runPendingDeletion(asset).catch((error: unknown) => {
          logger.error('Unexpected local audio pending-deletion failure; retrying', error, {
            roomId: asset.roomId,
            assetId: asset.assetId,
          })
          if (this.tracksAsset(asset)) this.schedulePendingDeletion(asset)
        })
      },
      Math.max(0, delayMs),
    )
    asset.deleteTimer.unref?.()
  }

  private async runPendingDeletion(asset: AssetRecord): Promise<void> {
    if (!this.tracksAsset(asset)) return
    const currentAssetId = roomRepo.get(asset.roomId)?.currentTrack?.assetId
    if (currentAssetId === asset.assetId) {
      this.schedulePendingDeletion(asset)
      return
    }
    if (asset.activeStreams > 0) {
      this.closeActiveStreams(asset)
      if (asset.activeStreams > 0) {
        this.schedulePendingDeletion(asset, STREAM_CLOSE_RETRY_MS)
        return
      }
    }
    await this.finalizeAssetDeletion(asset)
  }

  private async removeAssetDirectory(asset: AssetRecord): Promise<void> {
    await rm(path.dirname(asset.primaryPath), { recursive: true, force: true })
  }

  private async finalizeAssetDeletion(asset: AssetRecord): Promise<void> {
    const index = this.rooms.get(asset.roomId)
    if (index?.assets.get(asset.assetId) !== asset) return
    const room = roomRepo.get(asset.roomId)
    if (room) {
      const removedIds = room.queue.filter((track) => track.assetId === asset.assetId).map((track) => track.id)
      if (removedIds.length > 0) {
        room.queue = room.queue.filter((track) => track.assetId !== asset.assetId)
        for (const trackId of removedIds) {
          room.trackLikes.delete(trackId)
          room.trackLikeTimestamps.delete(trackId)
        }
        this.io?.to(asset.roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: removedIds })
      }
      const removedRefs = room.defaultQueue.filter((ref) => ref.assetId === asset.assetId)
      room.defaultQueue = room.defaultQueue.filter((ref) => ref.assetId !== asset.assetId)
      if (removedRefs.length > 0) {
        this.broadcastDefaultQueueDelta(asset.roomId, { type: 'remove', trackIds: removedRefs.map((ref) => ref.id) })
      }
      room.playedHistory = room.playedHistory.filter((entry) => entry.track.assetId !== asset.assetId)
      this.io?.to(asset.roomId).emit(EVENTS.PLAYED_HISTORY_UPDATED, { playedHistory: room.playedHistory })
    }

    try {
      await this.removeAssetDirectory(asset)
    } catch (error) {
      asset.deleteRetryCount += 1
      const retryInMs = this.deleteRetryDelay(asset.deleteRetryCount)
      logger.error('Failed to delete local audio asset directory; retrying', error, {
        roomId: asset.roomId,
        assetId: asset.assetId,
        attempt: asset.deleteRetryCount,
        retryInMs,
      })
      this.schedulePendingDeletion(asset, retryInMs)
      return
    }

    // Room cleanup may have detached this index while the filesystem removal
    // was in flight. Only the current owner of the record may release quota.
    const currentIndex = this.rooms.get(asset.roomId)
    if (currentIndex?.assets.get(asset.assetId) !== asset) return
    currentIndex.assets.delete(asset.assetId)
    this.finalBytes = Math.max(0, this.finalBytes - asset.sizeBytes)
    this.emitSnapshot(asset.roomId)
  }

  getVariant(
    roomId: string,
    assetId: string,
    variant: LocalAudioAccessVariant,
  ): { path: string; size: number; contentType: string; asset: AssetRecord } | null {
    const asset = this.getAsset(roomId, assetId)
    if (!asset) return null
    if (asset.pendingDelete && roomRepo.get(roomId)?.currentTrack?.assetId !== assetId) return null
    if (variant === 'cover') {
      if (!asset.coverPath) return null
      return { path: asset.coverPath, size: 0, contentType: 'image/jpeg', asset }
    }
    if (variant === 'fallback') {
      if (!asset.fallbackPath || !asset.fallbackSizeBytes) return null
      return { path: asset.fallbackPath, size: asset.fallbackSizeBytes, contentType: 'audio/mpeg', asset }
    }
    return { path: asset.primaryPath, size: asset.primarySizeBytes, contentType: asset.primaryMimeType, asset }
  }

  beginStream(asset: AssetRecord, closeStream: () => void): () => void {
    asset.activeStreams += 1
    asset.activeStreamClosers.add(closeStream)
    let released = false
    return () => {
      if (released) return
      released = true
      asset.activeStreamClosers.delete(closeStream)
      asset.activeStreams = Math.max(0, asset.activeStreams - 1)
      if (asset.pendingDelete && this.tracksAsset(asset)) this.schedulePendingDeletion(asset, 0)
    }
  }

  private async removeRoomFiles(roomId: string, index: RoomIndex | undefined): Promise<void> {
    await rm(path.join(this.assetsDir, roomId), { recursive: true, force: true })
    if (!index) return
    await Promise.all(
      Array.from(index.tasks.values()).flatMap((task) => [
        rm(task.partPath, { force: true }),
        rm(task.inputPath, { force: true }),
      ]),
    )
  }

  private async retryRoomFileCleanup(roomId: string, index: RoomIndex | undefined): Promise<void> {
    let attempt = 0
    for (;;) {
      try {
        await this.removeRoomFiles(roomId, index)
        return
      } catch (error) {
        attempt += 1
        const retryInMs = this.deleteRetryDelay(attempt)
        logger.error('Failed to clean local audio room files; retrying', error, {
          roomId,
          attempt,
          retryInMs,
        })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryInMs)
          timer.unref?.()
        })
      }
    }
  }

  private async performRoomCleanup(roomId: string): Promise<void> {
    const index = this.rooms.get(roomId)
    if (index) {
      for (const task of index.tasks.values()) {
        if (isActiveStage(task.stage)) {
          task.abortController.abort(new Error('room deleted'))
          task.requestDestroy?.()
          task.stage = 'cancelled'
        }
        if (task.inputTimer) clearTimeout(task.inputTimer)
        if (task.retentionTimer) clearTimeout(task.retentionTimer)
        if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
        task.inputTimer = undefined
        task.retentionTimer = undefined
        task.cleanupTimer = undefined
      }
      for (const asset of index.assets.values()) {
        if (asset.deleteTimer) clearTimeout(asset.deleteTimer)
        asset.deleteTimer = undefined
      }
      // Detach before closing streams. Their release callbacks must not create
      // new pending-delete timers while this room is being destroyed.
      this.rooms.delete(roomId)
      for (const asset of index.assets.values()) this.closeActiveStreams(asset)
    }

    // Keep the cleanup promise and all quota reservations alive until every
    // physical file is gone. This prevents silent orphan files and blocks a
    // newly recreated room with the same ID from racing the old directory.
    await this.retryRoomFileCleanup(roomId, index)

    if (index) {
      for (const task of index.tasks.values()) {
        if (task.tempReservationHeld) {
          task.tempReservationHeld = false
          this.tempReservedBytes = Math.max(0, this.tempReservedBytes - task.fileSize)
        }
        this.releaseFinalReservation(task)
      }
      for (const asset of index.assets.values()) {
        this.finalBytes = Math.max(0, this.finalBytes - asset.sizeBytes)
      }
    }
  }

  async cleanupRoom(roomId: string): Promise<void> {
    const pending = this.roomCleanupPromises.get(roomId)
    if (pending) {
      await pending
      return
    }
    const cleanup = this.performRoomCleanup(roomId)
    this.roomCleanupPromises.set(roomId, cleanup)
    try {
      await cleanup
    } finally {
      if (this.roomCleanupPromises.get(roomId) === cleanup) this.roomCleanupPromises.delete(roomId)
    }
  }

  async shutdown(): Promise<void> {
    this.beginShutdown()
    for (const [roomId] of this.rooms) await this.cleanupRoom(roomId)
    while (this.roomCleanupPromises.size > 0) {
      await Promise.all(Array.from(this.roomCleanupPromises.values()))
    }
  }
}

export const localAudioService = new LocalAudioService()

export function localAudioErrorPayload(error: unknown): { code: string; message: string } {
  const code = error instanceof Error ? error.message : ''
  switch (code) {
    case 'NO_PERMISSION':
      return { code: ERROR_CODE.NO_PERMISSION, message: '你没有权限执行此操作' }
    case 'LOCAL_AUDIO_NOT_FOUND':
      return { code: ERROR_CODE.LOCAL_AUDIO_NOT_FOUND, message: '本地音频或任务不存在' }
    case 'LOCAL_AUDIO_BUSY':
      return { code: ERROR_CODE.LOCAL_AUDIO_INVALID, message: '你已有一个正在进行的上传任务' }
    case 'LOCAL_AUDIO_TASK_LIMIT':
      return { code: ERROR_CODE.LOCAL_AUDIO_INVALID, message: '房间内本地音频任务过多，请稍后再试' }
    case 'LOCAL_AUDIO_INVALID_SIZE':
      return {
        code: ERROR_CODE.LOCAL_AUDIO_INVALID,
        message: `单个文件必须小于等于 ${bytesToMiB(config.localAudio.maxUploadBytes)} MiB`,
      }
    case 'LOCAL_AUDIO_QUOTA_EXCEEDED':
      return { code: ERROR_CODE.LOCAL_AUDIO_QUOTA_EXCEEDED, message: '房间或服务器存储配额不足' }
    case 'LOCAL_AUDIO_DISK_LOW':
      return { code: ERROR_CODE.LOCAL_AUDIO_QUOTA_EXCEEDED, message: '服务器可用磁盘空间不足' }
    case 'LOCAL_AUDIO_SHUTTING_DOWN':
      return { code: ERROR_CODE.LOCAL_AUDIO_INVALID, message: '服务器正在关闭，暂不接受新的本地音频上传' }
    default:
      return { code: ERROR_CODE.LOCAL_AUDIO_INVALID, message: '本地音频请求无效' }
  }
}
