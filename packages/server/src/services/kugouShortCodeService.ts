import { LRUCache } from 'lru-cache'

const KUGOU_MIXSONG_BASE_URL = 'https://www.kugou.com/mixsong'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_LENGTH = 512_000

const resolvedCache = new LRUCache<string, KugouShortCodeTrack>({
  max: 500,
  ttl: 24 * 60 * 60 * 1000,
})
const inFlight = new Map<string, Promise<KugouShortCodeTrack>>()

export type KugouShortCodeErrorCode =
  | 'KUGOU_SHORT_CODE_NOT_FOUND'
  | 'KUGOU_SECURITY_VERIFICATION_REQUIRED'
  | 'KUGOU_UPSTREAM_TIMEOUT'
  | 'KUGOU_UPSTREAM_UNAVAILABLE'

export interface KugouShortCodeTrack {
  hash: string
  songName: string
  singerName: string
  albumName?: string
  duration: number
}

interface KugouMixsongData {
  hash?: unknown
  song_name?: unknown
  audio_name?: unknown
  author_name?: unknown
  album_name?: unknown
  timelength?: unknown
  encode_album_audio_id?: unknown
}

interface ResolveOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class KugouShortCodeError extends Error {
  constructor(
    public readonly code: KugouShortCodeErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'KugouShortCodeError'
  }
}

export function isKugouShortCode(value: string): boolean {
  return /^(?=.{6,14}$)(?=.*[a-z])[a-z0-9]+$/i.test(value)
}

function notFoundError(): KugouShortCodeError {
  return new KugouShortCodeError('KUGOU_SHORT_CODE_NOT_FOUND', '酷狗短码无效或已过期', 404)
}

function upstreamError(): KugouShortCodeError {
  return new KugouShortCodeError('KUGOU_UPSTREAM_UNAVAILABLE', '酷狗服务暂时不可用，请稍后重试', 502)
}

function securityVerificationError(): KugouShortCodeError {
  return new KugouShortCodeError('KUGOU_SECURITY_VERIFICATION_REQUIRED', '酷狗暂时要求安全验证，请稍后重试', 429)
}

/** Extract the JSON array assigned to `dataFromSmarty` without evaluating page scripts. */
function extractEmbeddedJson(html: string): string | null {
  const marker = 'dataFromSmarty'
  const markerIndex = html.indexOf(marker)
  if (markerIndex === -1) return null

  const assignmentIndex = html.indexOf('=', markerIndex + marker.length)
  const startIndex = html.indexOf('[', assignmentIndex + 1)
  if (assignmentIndex === -1 || startIndex === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIndex; i < html.length; i++) {
    const char = html[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '[') {
      depth++
    } else if (char === ']') {
      depth--
      if (depth === 0) return html.slice(startIndex, i + 1)
    }
  }

  return null
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || /timed?\s*out/i.test(error.message))
  )
}

async function readTextWithLimit(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_LENGTH) throw upstreamError()
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let receivedLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedLength += value.byteLength
      if (receivedLength > MAX_RESPONSE_LENGTH) {
        await reader.cancel()
        throw upstreamError()
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

async function resolveUncached(
  shortCode: string,
  { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }: ResolveOptions = {},
): Promise<KugouShortCodeTrack> {
  let response: Response
  try {
    response = await fetchImpl(`${KUGOU_MIXSONG_BASE_URL}/${encodeURIComponent(shortCode)}.html`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
      },
    })
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new KugouShortCodeError('KUGOU_UPSTREAM_TIMEOUT', '酷狗响应超时，请稍后重试', 504)
    }
    throw upstreamError()
  }

  if (response.status >= 300 && response.status < 400) throw notFoundError()
  if (response.status === 404) throw notFoundError()
  if (response.status === 401) {
    throw new KugouShortCodeError('KUGOU_UPSTREAM_UNAVAILABLE', '酷狗服务暂时不可用，请稍后重试', 502)
  }
  if (response.status === 403 || response.status === 429 || response.headers.has('ssa-code')) {
    throw securityVerificationError()
  }
  if (!response.ok) throw upstreamError()

  let html: string
  try {
    html = await readTextWithLimit(response)
  } catch (error) {
    if (error instanceof KugouShortCodeError) throw error
    if (isTimeoutError(error)) {
      throw new KugouShortCodeError('KUGOU_UPSTREAM_TIMEOUT', '酷狗响应超时，请稍后重试', 504)
    }
    throw upstreamError()
  }

  const embeddedJson = extractEmbeddedJson(html)
  if (!embeddedJson) {
    if (/SSA-CODE|["']?err_code["']?\s*[:=]\s*30020/i.test(html)) throw securityVerificationError()
    throw upstreamError()
  }

  let records: KugouMixsongData[]
  try {
    records = JSON.parse(embeddedJson) as KugouMixsongData[]
  } catch {
    throw upstreamError()
  }

  const record = records[0]
  if (!record) throw notFoundError()

  const encodedId = typeof record.encode_album_audio_id === 'string' ? record.encode_album_audio_id.toLowerCase() : ''
  const hash = typeof record.hash === 'string' ? record.hash.toUpperCase() : ''
  if (encodedId !== shortCode || !/^[A-F0-9]{32}$/.test(hash)) throw upstreamError()

  const singerName = typeof record.author_name === 'string' ? record.author_name.trim() : ''
  let songName = typeof record.song_name === 'string' ? record.song_name.trim() : ''
  if (!songName && typeof record.audio_name === 'string') {
    const prefix = singerName ? `${singerName} - ` : ''
    songName = record.audio_name.startsWith(prefix)
      ? record.audio_name.slice(prefix.length).trim()
      : record.audio_name.trim()
  }

  return {
    hash,
    songName,
    singerName,
    albumName: typeof record.album_name === 'string' ? record.album_name.trim() : undefined,
    duration: Math.max(0, Math.round(Number(record.timelength ?? 0) / 1000)),
  }
}

export async function resolveKugouShortCode(value: string, options: ResolveOptions = {}): Promise<KugouShortCodeTrack> {
  const shortCode = value.trim().toLowerCase()
  if (!isKugouShortCode(shortCode)) throw notFoundError()

  // Injected fetches are test-only and should never share production cache state.
  if (options.fetchImpl) return resolveUncached(shortCode, options)

  const cached = resolvedCache.get(shortCode)
  if (cached) return cached

  const pending = inFlight.get(shortCode)
  if (pending) return pending

  const request = resolveUncached(shortCode, options)
    .then((resolved) => {
      resolvedCache.set(shortCode, resolved)
      return resolved
    })
    .finally(() => {
      inFlight.delete(shortCode)
    })

  inFlight.set(shortCode, request)
  return request
}
