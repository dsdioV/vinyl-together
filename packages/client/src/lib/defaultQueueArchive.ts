import type { DefaultQueueTrackRef } from '@music-together/shared'
import { EVENTS, LIMITS } from '@music-together/shared'
import type { Socket } from 'socket.io-client'
import { emitInChunks } from './batchQueueAdd'
import { storage } from './storage'

/**
 * 默认歌单浏览器存档：把房间默认播放列表的轻量引用（DefaultQueueTrackRef）
 * 原样存入 localStorage，随用户数据走；JSON 文件用于备份、分享与换设备。
 *
 * 本地音频资产随房间销毁，无法跨房间恢复，因此存档/导入一律剔除 local 引用。
 * 恢复走 DEFAULT_QUEUE_ADD_REFS：只提交引用，元数据由服务端在播放时懒补全，
 * 失效条目（平台下架等）会被服务端自动移除并提示。
 */

export interface DefaultQueueSnapshot {
  savedAt: number
  name?: string
  tracks: DefaultQueueTrackRef[]
}

/** 存档歌曲上限（与服务端单个外部歌单上限对齐，兼顾 localStorage 配额） */
export const SNAPSHOT_MAX_TRACKS = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS

const SNAPSHOT_KIND = 'vinyl-default-queue-snapshot'
const SNAPSHOT_VERSION = 1

const ONLINE_SOURCES: ReadonlySet<string> = new Set(['netease', 'tencent', 'kugou', 'bilibili', 'bandcamp'])

function normalizeRef(raw: unknown): DefaultQueueTrackRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!ONLINE_SOURCES.has(String(r.source))) return null
  if (typeof r.id !== 'string' || !r.id.trim()) return null
  if (typeof r.sourceId !== 'string' || !r.sourceId.trim()) return null
  if (typeof r.title !== 'string' || !r.title.trim()) return null
  if (!Array.isArray(r.artist)) return null
  const artist = r.artist.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
  if (artist.length === 0) return null
  return {
    id: r.id.trim(),
    source: r.source as DefaultQueueTrackRef['source'],
    sourceId: r.sourceId.trim(),
    title: r.title.trim(),
    artist,
  }
}

/** 按 id 与 source:sourceId 双重去重（保持首次出现顺序） */
export function dedupeRefs(refs: readonly DefaultQueueTrackRef[]): { unique: DefaultQueueTrackRef[]; duplicates: number } {
  const seenIds = new Set<string>()
  const seenKeys = new Set<string>()
  const unique: DefaultQueueTrackRef[] = []
  let duplicates = 0
  for (const ref of refs) {
    const key = `${ref.source}:${ref.sourceId}`
    if (seenIds.has(ref.id) || seenKeys.has(key)) {
      duplicates++
      continue
    }
    seenIds.add(ref.id)
    seenKeys.add(key)
    unique.push(ref)
  }
  return { unique, duplicates }
}

/** 由房间默认队列构建存档条目：剔除本地音频引用并去重 */
export function buildSnapshotFromRoomRefs(
  refs: readonly DefaultQueueTrackRef[],
): { tracks: DefaultQueueTrackRef[]; skippedLocal: number; duplicates: number } {
  const online = refs.filter((ref) => ONLINE_SOURCES.has(ref.source))
  const skippedLocal = refs.length - online.length
  const { unique, duplicates } = dedupeRefs(online)
  return { tracks: unique.slice(0, SNAPSHOT_MAX_TRACKS), skippedLocal, duplicates }
}

/** 读取浏览器本地存档（防御性校验，坏数据静默丢弃） */
export function readLocalSnapshot(): DefaultQueueSnapshot | null {
  const raw = storage.getDefaultQueueSnapshot() as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) return null
  const tracks: DefaultQueueTrackRef[] = []
  const seen = new Set<string>()
  for (const rawRef of raw.tracks) {
    const ref = normalizeRef(rawRef)
    if (!ref) continue
    const key = `${ref.source}:${ref.sourceId}`
    if (seen.has(ref.id) || seen.has(key)) continue
    seen.add(ref.id)
    seen.add(key)
    tracks.push(ref)
    if (tracks.length >= SNAPSHOT_MAX_TRACKS) break
  }
  if (tracks.length === 0) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
  return {
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
    ...(name ? { name } : {}),
    tracks,
  }
}

export function writeLocalSnapshot(tracks: readonly DefaultQueueTrackRef[], savedAt = Date.now()): DefaultQueueSnapshot {
  const snapshot: DefaultQueueSnapshot = { savedAt, tracks: tracks.slice(0, SNAPSHOT_MAX_TRACKS) }
  storage.setDefaultQueueSnapshot({ kind: SNAPSHOT_KIND, version: SNAPSHOT_VERSION, ...snapshot })
  return snapshot
}

// ---------------------------------------------------------------------------
// JSON 文件导入 / 导出
// ---------------------------------------------------------------------------

export function snapshotToJsonString(snapshot: DefaultQueueSnapshot): string {
  return JSON.stringify(
    { kind: SNAPSHOT_KIND, version: SNAPSHOT_VERSION, exportedAt: new Date().toISOString(), ...snapshot },
    null,
    2,
  )
}

export function downloadSnapshotFile(snapshot: DefaultQueueSnapshot): void {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const blob = new Blob([snapshotToJsonString(snapshot)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `vinyl-default-queue-${stamp}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export interface ParsedSnapshotFile {
  tracks: DefaultQueueTrackRef[]
  skippedInvalid: number
  duplicates: number
  truncated: number
  savedAt?: number
  name?: string
}

/** 解析存档 JSON 文件：校验、剔除本地引用、去重并截断到上限 */
export function parseSnapshotFile(text: string): ParsedSnapshotFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSON 格式错误')
  }
  const container = (data ?? {}) as Record<string, unknown>
  if (container.kind !== undefined && container.kind !== SNAPSHOT_KIND) {
    throw new Error('不是默认歌单存档文件')
  }
  const rawTracks = Array.isArray(container.tracks) ? container.tracks : null
  if (!rawTracks || rawTracks.length === 0) throw new Error('文件中没有歌曲数据')

  const seen = new Set<string>()
  const tracks: DefaultQueueTrackRef[] = []
  let skippedInvalid = 0
  let duplicates = 0
  for (const rawRef of rawTracks) {
    const ref = normalizeRef(rawRef)
    if (!ref) {
      skippedInvalid++
      continue
    }
    const key = `${ref.source}:${ref.sourceId}`
    if (seen.has(ref.id) || seen.has(key)) {
      duplicates++
      continue
    }
    if (tracks.length >= SNAPSHOT_MAX_TRACKS) break
    seen.add(ref.id)
    seen.add(key)
    tracks.push(ref)
  }
  const truncated = rawTracks.length - skippedInvalid - duplicates - tracks.length
  return {
    tracks,
    skippedInvalid,
    duplicates,
    truncated: Math.max(0, truncated),
    ...(typeof container.savedAt === 'number' ? { savedAt: container.savedAt } : {}),
    ...(typeof container.name === 'string' && container.name.trim() ? { name: container.name.trim() } : {}),
  }
}

export async function readSnapshotFile(file: File): Promise<ParsedSnapshotFile> {
  return parseSnapshotFile(await file.text())
}

// ---------------------------------------------------------------------------
// 恢复到房间（DEFAULT_QUEUE_ADD_REFS 分块发送）
// ---------------------------------------------------------------------------

export interface RestoreProgress {
  sent: number
  total: number
}

export interface RestoreResult {
  /** 实际提交到服务器的引用数 */
  queued: number
  skippedDuplicates: number
  truncated: number
}

/**
 * 把存档条目追加到房间默认播放列表：
 * 客户端先按当前列表去重并按容量截断，再以 500/块分块发送 DEFAULT_QUEUE_ADD_REFS。
 * 服务端会再次幂等去重，因此重复恢复同一存档是安全的。
 */
export async function restoreSnapshotToRoom(options: {
  socket: Socket
  tracks: readonly DefaultQueueTrackRef[]
  currentRefs: readonly DefaultQueueTrackRef[]
  onProgress?: (progress: RestoreProgress) => void
}): Promise<RestoreResult> {
  const { socket, tracks, currentRefs, onProgress } = options

  const existingIds = new Set(currentRefs.map((ref) => ref.id))
  const existingKeys = new Set(currentRefs.map((ref) => `${ref.source}:${ref.sourceId}`))
  const remainingCapacity = Math.max(0, LIMITS.DEFAULT_QUEUE_MAX_SIZE - currentRefs.length)

  const queued: DefaultQueueTrackRef[] = []
  let skippedDuplicates = 0
  let truncated = 0
  for (const ref of tracks) {
    const key = `${ref.source}:${ref.sourceId}`
    if (existingIds.has(ref.id) || existingKeys.has(key)) {
      skippedDuplicates++
      continue
    }
    if (queued.length >= remainingCapacity) {
      truncated++
      continue
    }
    existingIds.add(ref.id)
    existingKeys.add(key)
    queued.push(ref)
  }

  if (queued.length > 0) {
    let sent = 0
    await emitInChunks(queued, (chunk) => {
      socket.emit(EVENTS.DEFAULT_QUEUE_ADD_REFS, { refs: chunk })
      sent += chunk.length
      onProgress?.({ sent, total: queued.length })
    })
  }
  return { queued: queued.length, skippedDuplicates, truncated }
}
