import { SERVER_URL } from '@/lib/config'
import type { LocalAudioAsset, LocalAudioState, LocalAudioTask, LocalAudioTaskStage } from '@music-together/shared'

export type { LocalAudioAsset, LocalAudioState, LocalAudioTask, LocalAudioTaskStage }

/** REST envelopes are transport shapes; their contents use shared DTOs. */
export type LocalAudioTaskResponse = {
  task: LocalAudioTask
  asset?: LocalAudioAsset
}

const API_ROOT = '/api/rooms'

function roomPath(roomId: string): string {
  return `${SERVER_URL}${API_ROOT}/${encodeURIComponent(roomId)}/local-audio`
}

export function localAudioApi(roomId: string, suffix = ''): string {
  return `${roomPath(roomId)}${suffix}`
}

export function localAudioTasksApi(roomId: string): string {
  return localAudioApi(roomId, '/tasks')
}

export function localAudioTaskContentApi(roomId: string, taskId: string): string {
  return `${localAudioTasksApi(roomId)}/${encodeURIComponent(taskId)}/content`
}

export function localAudioAssetApi(roomId: string, assetId: string): string {
  return `${localAudioApi(roomId, '/assets')}/${encodeURIComponent(assetId)}`
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function responseMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const candidate = body as Record<string, unknown>
    if (typeof candidate.message === 'string') return candidate.message
    if (typeof candidate.error === 'string') return candidate.error
  }
  return `请求失败（${status}）`
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { ...init, credentials: 'include' })
  const body = await parseResponse(response)
  if (!response.ok) {
    throw new Error(responseMessage(body, response.status))
  }
  return body as T
}

export function fetchLocalAudioSnapshot(roomId: string, signal?: AbortSignal): Promise<LocalAudioState> {
  return requestJson<LocalAudioState>(localAudioApi(roomId), { signal })
}

export function createLocalAudioTask(
  roomId: string,
  data: { fileName: string; fileSize: number; addToQueue: boolean },
  signal?: AbortSignal,
): Promise<LocalAudioTaskResponse> {
  return requestJson<LocalAudioTaskResponse>(localAudioTasksApi(roomId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  })
}

export function updateLocalAudioAsset(
  roomId: string,
  assetId: string,
  data: { title?: string; artist?: string[]; album?: string },
): Promise<{ asset: LocalAudioAsset }> {
  return requestJson<{ asset: LocalAudioAsset }>(localAudioAssetApi(roomId, assetId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function deleteLocalAudioAsset(roomId: string, assetId: string, removeFromQueue = false): Promise<void> {
  const suffix = removeFromQueue ? '?removeFromQueue=true' : ''
  return requestJson<void>(`${localAudioAssetApi(roomId, assetId)}${suffix}`, { method: 'DELETE' })
}

export function cancelLocalAudioTask(roomId: string, taskId: string): Promise<void> {
  return requestJson<void>(`${localAudioTasksApi(roomId)}/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
}

export interface UploadHandle {
  promise: Promise<LocalAudioTaskResponse>
  abort: () => void
}

/**
 * Upload the raw file with XHR because fetch does not expose upload progress.
 * The endpoint expects the task id in the URL and the file as the raw body.
 */
export function uploadLocalAudioContent(
  roomId: string,
  taskId: string,
  file: File,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest()
  let settled = false

  const promise = new Promise<LocalAudioTaskResponse>((resolve, reject) => {
    xhr.open('PUT', localAudioTaskContentApi(roomId, taskId))
    xhr.withCredentials = true
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total)
    }
    xhr.onload = async () => {
      if (settled) return
      settled = true
      let body: unknown = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as LocalAudioTaskResponse)
      } else {
        reject(new Error(responseMessage(body, xhr.status).replace(/^请求失败/, '上传失败')))
      }
    }
    xhr.onerror = () => {
      if (settled) return
      settled = true
      reject(new Error('上传连接中断'))
    }
    xhr.onabort = () => {
      if (settled) return
      settled = true
      reject(new DOMException('上传已取消', 'AbortError'))
    }
    xhr.send(file)
  })

  return { promise, abort: () => xhr.abort() }
}

export function isLocalAudioTerminal(stage: LocalAudioTaskStage): boolean {
  return stage === 'ready' || stage === 'failed' || stage === 'cancelled'
}

export function localAudioStatusLabel(stage: LocalAudioTaskStage): string {
  switch (stage) {
    case 'waiting-upload':
      return '等待上传'
    case 'receiving':
      return '上传中'
    case 'queued':
      return '等待处理'
    case 'probing':
      return '分析音频'
    case 'transcoding':
      return '转码中'
    case 'ready':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
  }
}

export function localAudioStatusProgress(
  task: Pick<LocalAudioTask, 'stage' | 'progress' | 'receivedBytes' | 'totalBytes'>,
): number | null {
  if (task.stage === 'receiving' && task.totalBytes && task.totalBytes > 0) {
    return Math.min(100, Math.max(0, ((task.receivedBytes ?? 0) / task.totalBytes) * 100))
  }
  if (typeof task.progress === 'number' && Number.isFinite(task.progress)) {
    // Shared DTO uses a 0..1 fraction. Accept a percentage as a compatibility
    // convenience for an older development server.
    const value = task.progress <= 1 ? task.progress * 100 : task.progress
    return Math.min(100, Math.max(0, value))
  }
  return null
}
