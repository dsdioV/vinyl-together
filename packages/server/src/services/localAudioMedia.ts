import { spawn, type ChildProcessByStdio } from 'node:child_process'
import {
  stat as fsStat,
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  open as fsOpen,
  unlink as fsUnlink,
} from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { AudioQuality } from '@music-together/shared'

/** Hard media limits shared by the upload service and this low-level module. */
export const LOCAL_AUDIO_MEDIA_LIMITS = {
  /** Maximum original upload size. */
  maxUploadBytes: 500 * 1024 * 1024,
  /** Maximum edge of an extracted embedded cover. */
  coverMaxEdge: 512,
  /** Covers are deliberately small: they are displayed as thumbnails only. */
  coverMaxBytes: 512 * 1024,
  /** Default deadline for a single ffprobe/ffmpeg invocation. */
  commandTimeoutMs: 10 * 60 * 1000,
  /** Keep child-process diagnostics bounded. */
  commandOutputMaxBytes: 128 * 1024,
  /** Keep one conversion task from consuming every CPU thread by default. */
  defaultFfmpegThreads: 1,
} as const

/**
 * Uploaded media is always opened from a server-generated local path. Keeping
 * the protocol whitelist to `file` prevents nested HTTP/concat-style inputs
 * from turning ffprobe/ffmpeg into an SSRF client. `pipe` is not required:
 * process stdio is unrelated to FFmpeg's `pipe:` input protocol.
 */
const LOCAL_AUDIO_INPUT_PROTOCOL_WHITELIST = 'file'

/** Demuxer names used by FFmpeg for every container accepted below. */
const LOCAL_AUDIO_INPUT_FORMAT_WHITELIST = 'mp3,mov,flac,wav,aiff,ogg,matroska'

/** EBML headers are small; bounding the read keeps container checks cheap. */
const LOCAL_AUDIO_EBML_HEADER_MAX_BYTES = 4096

export type LocalAudioQuality = AudioQuality

export type LocalAudioContainer = 'mp3' | 'mp4' | 'flac' | 'wav' | 'aiff' | 'ogg' | 'webm'

export type LocalAudioCodec = 'mp3' | 'aac' | 'alac' | 'flac' | 'vorbis' | 'opus' | `pcm_${string}`

/** The formats accepted after inspecting the actual media stream. */
export const SUPPORTED_LOCAL_AUDIO_FORMATS = [
  'mp3',
  'm4a/aac',
  'm4a/alac',
  'flac',
  'wav/pcm',
  'wav/float',
  'aiff/pcm',
  'aiff/float',
  'ogg/vorbis',
  'ogg/opus',
  'webm/vorbis',
  'webm/opus',
] as const

export type SupportedLocalAudioFormat = (typeof SUPPORTED_LOCAL_AUDIO_FORMATS)[number]

export type LocalAudioMediaErrorCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_FAILED'
  | 'PROBE_FAILED'
  | 'INVALID_MEDIA'
  | 'OUTPUT_TOO_LARGE'
  | 'COVER_EXTRACTION_FAILED'
  | 'INVALID_RANGE'

/** Error with a stable code suitable for mapping to an HTTP/socket error. */
export class LocalAudioMediaError extends Error {
  readonly code: LocalAudioMediaErrorCode
  readonly exitCode?: number | null
  readonly stderr?: string

  constructor(
    code: LocalAudioMediaErrorCode,
    message: string,
    options?: { cause?: unknown; exitCode?: number | null; stderr?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LocalAudioMediaError'
    this.code = code
    this.exitCode = options?.exitCode
    this.stderr = options?.stderr
  }
}

export interface ProbeStream {
  codec_type?: unknown
  codec_name?: unknown
  codec_long_name?: unknown
  bit_rate?: unknown
  duration?: unknown
  sample_rate?: unknown
  channels?: unknown
  disposition?: Record<string, unknown>
  tags?: Record<string, unknown>
}

export interface ProbeFormat {
  format_name?: unknown
  format_long_name?: unknown
  duration?: unknown
  size?: unknown
  bit_rate?: unknown
  tags?: Record<string, unknown>
}

/** Shape emitted by `ffprobe -of json -show_streams -show_format`. */
export interface ProbeResult {
  streams?: ProbeStream[]
  format?: ProbeFormat
}

export interface LocalAudioMetadata {
  title: string
  artist: string[]
  album: string
  durationSeconds: number
  /** Rounded-up kbps; undefined when the source did not expose a bitrate. */
  bitrateKbps?: number
  sampleRate?: number
  channels?: number
  sizeBytes?: number
  container: LocalAudioContainer
  codec: LocalAudioCodec
  format: SupportedLocalAudioFormat
  /** True for FLAC, ALAC, PCM and other lossless inputs. */
  lossless: boolean
  /** Whether an attached-picture stream was found. */
  hasEmbeddedCover: boolean
}

export interface ProbeRequest {
  filePath: string
  signal?: AbortSignal
  timeoutMs: number
}

export interface FfmpegRequest {
  args: readonly string[]
  signal?: AbortSignal
  timeoutMs: number
}

/** Injectable probe and ffmpeg boundaries. Tests can replace these without spawning processes. */
export type ProbeExecutor = (request: ProbeRequest) => Promise<ProbeResult>
export type FfmpegExecutor = (request: FfmpegRequest) => Promise<void>

export interface MediaFileInfo {
  size: number
}

/** Minimal filesystem surface used by the media pipeline. */
export interface MediaFileSystem {
  stat(filePath: string): Promise<MediaFileInfo>
  readHeader(filePath: string, maxBytes: number): Promise<Buffer>
  copyFile(source: string, destination: string): Promise<void>
  mkdir(directory: string): Promise<void>
  unlink(filePath: string): Promise<void>
}

const defaultFileSystem: MediaFileSystem = {
  async stat(filePath) {
    const result = await fsStat(filePath)
    return { size: result.size }
  },
  async readHeader(filePath, maxBytes) {
    const handle = await fsOpen(filePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  },
  copyFile: fsCopyFile,
  async mkdir(directory) {
    await fsMkdir(directory, { recursive: true })
  },
  unlink: fsUnlink,
}

export interface CommandResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface CommandRunnerOptions {
  signal?: AbortSignal
  timeoutMs: number
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandRunnerOptions,
) => Promise<CommandResult>

export type CommandSpawner = (command: string, args: readonly string[]) => ChildProcessByStdio<null, Readable, Readable>

function abortError(reason?: unknown): LocalAudioMediaError {
  return new LocalAudioMediaError('ABORTED', '媒体处理已取消', { cause: reason })
}

function timeoutError(command: string, timeoutMs: number): LocalAudioMediaError {
  return new LocalAudioMediaError('TIMEOUT', `${command} 执行超时（${timeoutMs}ms）`)
}

function appendBounded(chunks: Buffer[], chunk: Buffer, maxBytes: number, currentBytes: { value: number }): void {
  if (currentBytes.value >= maxBytes) return
  const remaining = maxBytes - currentBytes.value
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
  chunks.push(slice)
  currentBytes.value += slice.length
}

/**
 * Spawn a command without a shell. The explicit runner is exported so the
 * service can be tested with a fake executor and so a future deployment can
 * provide a sandboxed runner.
 */
export function createCommandRunner(spawnCommand: CommandSpawner): CommandRunner {
  return (command, args, options) => {
    return new Promise<CommandResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError(options.signal.reason))
        return
      }

      let child: ChildProcessByStdio<null, Readable, Readable>
      try {
        child = spawnCommand(command, args)
      } catch (error) {
        reject(new LocalAudioMediaError('COMMAND_NOT_FOUND', `无法启动 ${command}`, { cause: error }))
        return
      }

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const stdoutBytes = { value: 0 }
      const stderrBytes = { value: 0 }
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      let requestedError: LocalAudioMediaError | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        child.stdout.removeAllListeners('data')
        child.stderr.removeAllListeners('data')
      }

      const settleReject = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      const requestTermination = (error: LocalAudioMediaError) => {
        if (settled || requestedError) return
        requestedError = error
        child.kill('SIGKILL')
      }

      const onAbort = () => requestTermination(abortError(options.signal?.reason))

      child.stdout.on('data', (chunk: Buffer | string) => {
        appendBounded(
          stdout,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          LOCAL_AUDIO_MEDIA_LIMITS.commandOutputMaxBytes,
          stdoutBytes,
        )
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        appendBounded(
          stderr,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          LOCAL_AUDIO_MEDIA_LIMITS.commandOutputMaxBytes,
          stderrBytes,
        )
      })

      child.once('error', (error: NodeJS.ErrnoException) => {
        const mapped =
          error.code === 'ENOENT'
            ? new LocalAudioMediaError('COMMAND_NOT_FOUND', `找不到 ${command}`, { cause: error })
            : new LocalAudioMediaError('COMMAND_FAILED', `${command} 启动失败`, { cause: error })
        // A spawn failure has no child process or open output file to wait for.
        // Runtime failures keep the original process lifecycle authoritative and
        // settle on `close`, after its stdio handles have actually been released.
        if (child.pid === undefined) settleReject(mapped)
        else requestTermination(mapped)
      })

      child.once('close', (exitCode, signal) => {
        if (settled) return
        cleanup()
        const result: CommandResult = {
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }
        if (requestedError) {
          settled = true
          reject(requestedError)
          return
        }
        if (exitCode !== 0) {
          settled = true
          reject(
            new LocalAudioMediaError('COMMAND_FAILED', `${command} 执行失败`, {
              exitCode,
              stderr: result.stderr,
            }),
          )
          return
        }
        settled = true
        resolve(result)
      })

      options.signal?.addEventListener('abort', onAbort, { once: true })
      // The signal can flip between the initial check and listener registration.
      // Re-check after registering so a cancelled upload never leaves ffmpeg running.
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      if (options.timeoutMs > 0 && Number.isFinite(options.timeoutMs)) {
        timer = setTimeout(() => {
          requestTermination(timeoutError(command, options.timeoutMs))
        }, options.timeoutMs)
        timer.unref?.()
      }
    })
  }
}

export const defaultCommandRunner = createCommandRunner((command, args) =>
  spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  }),
)

function parseProbeJson(stdout: string): ProbeResult {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object') throw new Error('probe result is not an object')
    return parsed as ProbeResult
  } catch (error) {
    throw new LocalAudioMediaError('PROBE_FAILED', '无法解析 ffprobe 输出', { cause: error })
  }
}

export function createProbeExecutor(
  commandRunner: CommandRunner = defaultCommandRunner,
  ffprobePath = 'ffprobe',
): ProbeExecutor {
  return async ({ filePath, signal, timeoutMs }) => {
    const result = await commandRunner(
      ffprobePath,
      [
        '-v',
        'error',
        '-hide_banner',
        '-protocol_whitelist',
        LOCAL_AUDIO_INPUT_PROTOCOL_WHITELIST,
        '-format_whitelist',
        LOCAL_AUDIO_INPUT_FORMAT_WHITELIST,
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        filePath,
      ],
      { signal, timeoutMs },
    )
    return parseProbeJson(result.stdout)
  }
}

export function createFfmpegExecutor(
  commandRunner: CommandRunner = defaultCommandRunner,
  ffmpegPath = 'ffmpeg',
): FfmpegExecutor {
  return async ({ args, signal, timeoutMs }) => {
    await commandRunner(ffmpegPath, args, { signal, timeoutMs })
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const result = String(value).replace(/\0/g, '').trim()
  return result.length > 0 ? result : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isFinite(number) ? number : undefined
}

function parsePositiveNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value)
  return number !== undefined && number > 0 ? number : undefined
}

function parseBitrateKbps(value: unknown): number | undefined {
  const bitsPerSecond = parsePositiveNumber(value)
  if (bitsPerSecond === undefined) return undefined
  return Math.max(1, Math.ceil(bitsPerSecond / 1000))
}

function parseSampleRate(value: unknown): number | undefined {
  return parsePositiveNumber(value)
}

function parseChannels(value: unknown): number | undefined {
  const channels = parsePositiveNumber(value)
  return channels === undefined ? undefined : Math.floor(channels)
}

function normalizeFormatNames(value: unknown): string[] {
  return (asString(value) ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function normalizeCodec(value: unknown): string {
  return (asString(value) ?? '').toLowerCase()
}

interface EbmlVint {
  length: number
  value: number
  unknown: boolean
}

function readEbmlVint(bytes: Uint8Array, offset: number, maxLength: number, preserveMarker: boolean): EbmlVint | null {
  if (offset < 0 || offset >= bytes.length) return null
  const first = bytes[offset]!
  if (first === 0) return null

  let marker = 0x80
  let length = 1
  while ((first & marker) === 0) {
    marker >>= 1
    length += 1
    if (marker === 0 || length > maxLength) return null
  }
  if (offset + length > bytes.length) return null

  let unknown = !preserveMarker && (first & (marker - 1)) === marker - 1
  for (let index = 1; index < length && unknown; index += 1) {
    unknown = bytes[offset + index] === 0xff
  }
  if (unknown) return { length, value: 0, unknown: true }

  let value = preserveMarker ? first : first & (marker - 1)
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index]!
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - byte) / 256)) return null
    value = value * 256 + byte
  }
  return { length, value, unknown: false }
}

/**
 * Read the EBML DocType from a bounded file prefix. FFprobe reports both WebM
 * and Matroska as `matroska,webm`, so this header field is the authoritative
 * distinction and avoids trusting a user-controlled filename extension.
 */
export function parseEbmlDocType(header: Uint8Array): string | undefined {
  if (header.length < 5 || header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) {
    return undefined
  }

  const headerSize = readEbmlVint(header, 4, 8, false)
  if (!headerSize || headerSize.unknown) return undefined
  let cursor = 4 + headerSize.length
  const headerEnd = cursor + headerSize.value
  if (!Number.isSafeInteger(headerEnd) || headerEnd > header.length) return undefined
  let docType: string | undefined

  while (cursor < headerEnd) {
    const elementId = readEbmlVint(header, cursor, 4, true)
    if (!elementId || elementId.unknown) return undefined
    cursor += elementId.length

    const elementSize = readEbmlVint(header, cursor, 8, false)
    if (!elementSize || elementSize.unknown) return undefined
    cursor += elementSize.length

    const elementEnd = cursor + elementSize.value
    if (!Number.isSafeInteger(elementEnd) || elementEnd > headerEnd) return undefined
    if (elementId.value === 0x4282) {
      if (elementSize.value < 1 || elementSize.value > 32) return undefined
      const value = Buffer.from(header.subarray(cursor, elementEnd))
        .toString('ascii')
        .replace(/\0+$/g, '')
        .trim()
        .toLowerCase()
      if (docType !== undefined || !/^[a-z0-9._-]{1,32}$/.test(value)) return undefined
      docType = value
    }
    cursor = elementEnd
  }

  return docType
}

/**
 * FFmpeg treats some input strings as protocols (for example `http://` or
 * `concat:`). The upload service only ever supplies paths below its data
 * directory, so reject anything that is not an absolute local path at this
 * boundary. NUL is rejected explicitly because Node's filesystem APIs do not
 * accept it and it can otherwise make error handling ambiguous.
 */
function assertLocalMediaPath(filePath: string, label: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw new LocalAudioMediaError('INVALID_MEDIA', `${label}必须是绝对本地路径`)
  }
  return filePath
}

async function assertOutputPathAbsent(filePath: string, fileSystem: MediaFileSystem): Promise<void> {
  try {
    await fileSystem.stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    throw error
  }
  throw new LocalAudioMediaError('INVALID_MEDIA', '输出路径已存在')
}

function isAttachedPicture(stream: ProbeStream): boolean {
  const value = stream.disposition?.attached_pic
  return value === 1 || value === '1' || value === true
}

function getTag(tags: Record<string, unknown> | undefined, names: readonly string[]): string | undefined {
  if (!tags) return undefined
  const byLowerName = new Map<string, unknown>()
  for (const [key, value] of Object.entries(tags)) byLowerName.set(key.toLowerCase(), value)
  for (const name of names) {
    const value = asString(byLowerName.get(name.toLowerCase()))
    if (value) return value
  }
  return undefined
}

function normalizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim()
}

function fallbackTitleFromName(originalName?: string): string {
  const basename = (originalName ?? '').replace(/^.*[\\/]/, '')
  const withoutExtension = basename.replace(/\.[^.]+$/, '')
  return normalizeText(withoutExtension || basename, 500) || '本地音频'
}

function normalizeArtists(raw: string | undefined): string[] {
  if (!raw) return ['未知艺术家']
  const parts = raw
    .split(/[\u0000;；]+/)
    .map((part) => normalizeText(part, 200))
    .filter(Boolean)
  return parts.length > 0 ? Array.from(new Set(parts)).slice(0, 20) : ['未知艺术家']
}

export interface MetadataInput {
  title?: unknown
  artist?: unknown
  album?: unknown
}

/** Normalize untrusted tags and apply the documented local-audio fallbacks. */
export function sanitizeLocalAudioMetadata(
  input: MetadataInput,
  originalName?: string,
): Pick<LocalAudioMetadata, 'title' | 'artist' | 'album'> {
  const title = normalizeText(asString(input.title) ?? '', 500) || fallbackTitleFromName(originalName)
  const artistValue = Array.isArray(input.artist)
    ? input.artist
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item))
        .join(';')
    : asString(input.artist)
  const artist = normalizeArtists(artistValue)
  const album = normalizeText(asString(input.album) ?? '', 500) || '本地音乐'
  return { title, artist, album }
}

function pcmCodec(codec: string): boolean {
  // Include signed/unsigned integer and IEEE float PCM, but not μ-law/A-law.
  return /^pcm_(?:u|s|f)(?:8|16|20|24|32|64)(?:le|be)?$/.test(codec)
}

interface FormatClassification {
  container: LocalAudioContainer
  codec: LocalAudioCodec
  format: SupportedLocalAudioFormat
  lossless: boolean
}

function classifyFormat(formatNames: string[], codec: string, ebmlDocType?: string): FormatClassification | null {
  const has = (name: string) => formatNames.includes(name)

  if (has('mp3') && codec === 'mp3') {
    return { container: 'mp3', codec: 'mp3', format: 'mp3', lossless: false }
  }
  if ((has('mov') || has('mp4') || has('m4a') || has('3gp') || has('3g2') || has('mj2')) && codec === 'aac') {
    return { container: 'mp4', codec: 'aac', format: 'm4a/aac', lossless: false }
  }
  if ((has('mov') || has('mp4') || has('m4a') || has('3gp') || has('3g2') || has('mj2')) && codec === 'alac') {
    return { container: 'mp4', codec: 'alac', format: 'm4a/alac', lossless: true }
  }
  if (has('flac') && codec === 'flac') {
    return { container: 'flac', codec: 'flac', format: 'flac', lossless: true }
  }
  if (has('wav') && pcmCodec(codec)) {
    const float = codec.startsWith('pcm_f')
    return {
      container: 'wav',
      codec: codec as LocalAudioCodec,
      format: float ? 'wav/float' : 'wav/pcm',
      lossless: true,
    }
  }
  if ((has('aiff') || has('aif')) && pcmCodec(codec)) {
    const float = codec.startsWith('pcm_f')
    return {
      container: 'aiff',
      codec: codec as LocalAudioCodec,
      format: float ? 'aiff/float' : 'aiff/pcm',
      lossless: true,
    }
  }
  if (has('ogg') && (codec === 'vorbis' || codec === 'opus')) {
    return { container: 'ogg', codec: codec as 'vorbis' | 'opus', format: `ogg/${codec}`, lossless: false }
  }
  if ((has('webm') || has('matroska')) && ebmlDocType === 'webm' && (codec === 'vorbis' || codec === 'opus')) {
    return { container: 'webm', codec: codec as 'vorbis' | 'opus', format: `webm/${codec}`, lossless: false }
  }
  return null
}

export interface ValidateProbeOptions {
  originalName?: string
  sizeBytes?: number
  /** Parsed from the actual EBML header; required to distinguish WebM from Matroska. */
  ebmlDocType?: string
}

/**
 * Validate actual container/codec information from ffprobe. File extensions
 * and client MIME declarations are intentionally not consulted.
 */
export function validateLocalAudioProbe(probe: ProbeResult, options: ValidateProbeOptions = {}): LocalAudioMetadata {
  const streams = Array.isArray(probe.streams) ? probe.streams : []
  const audio = streams.find((stream) => asString(stream.codec_type)?.toLowerCase() === 'audio')
  if (!audio) {
    throw new LocalAudioMediaError('INVALID_MEDIA', '文件中没有音频流')
  }

  const unsupportedVideo = streams.some(
    (stream) => asString(stream.codec_type)?.toLowerCase() === 'video' && !isAttachedPicture(stream),
  )
  if (unsupportedVideo) {
    throw new LocalAudioMediaError('INVALID_MEDIA', '不接受包含视频内容的文件')
  }

  const formatNames = normalizeFormatNames(probe.format?.format_name)
  const codec = normalizeCodec(audio.codec_name)
  const classification = classifyFormat(formatNames, codec, normalizeCodec(options.ebmlDocType))
  if (!classification) {
    throw new LocalAudioMediaError('INVALID_MEDIA', '不支持的音频容器或编码格式')
  }

  const tags = { ...(probe.format?.tags ?? {}), ...(audio.tags ?? {}) }
  const metadata = sanitizeLocalAudioMetadata(
    {
      title: getTag(tags, ['title', 'trackname', 'name']),
      artist: getTag(tags, ['artist', 'album_artist', 'albumartist', 'performer']),
      album: getTag(tags, ['album']),
    },
    options.originalName,
  )

  const durationSeconds = parsePositiveNumber(audio.duration) ?? parsePositiveNumber(probe.format?.duration) ?? 0
  const bitrateKbps = parseBitrateKbps(audio.bit_rate) ?? parseBitrateKbps(probe.format?.bit_rate)
  const sampleRate = parseSampleRate(audio.sample_rate)
  const channels = parseChannels(audio.channels)
  const sizeFromProbe = parsePositiveNumber(probe.format?.size)
  const sizeBytes = options.sizeBytes ?? (sizeFromProbe === undefined ? undefined : Math.floor(sizeFromProbe))

  return {
    ...metadata,
    durationSeconds,
    bitrateKbps,
    sampleRate,
    channels,
    sizeBytes,
    ...classification,
    hasEmbeddedCover: streams.some(
      (stream) => asString(stream.codec_type)?.toLowerCase() === 'video' && isAttachedPicture(stream),
    ),
  }
}

export interface QualityOutputProfile {
  action: 'copy' | 'transcode'
  container: 'mp3' | 'flac'
  codec: 'mp3' | 'flac'
  extension: 'mp3' | 'flac'
  mimeType: 'audio/mpeg' | 'audio/flac'
  bitrateKbps?: number
}

export interface LocalAudioQualityProfile {
  requestedQuality: LocalAudioQuality
  primary: QualityOutputProfile
  /** Lossless rooms retain FLAC and get a universally playable MP3 fallback. */
  fallback?: QualityOutputProfile
}

function mp3Output(action: 'copy' | 'transcode', bitrateKbps: number): QualityOutputProfile {
  return { action, container: 'mp3', codec: 'mp3', extension: 'mp3', mimeType: 'audio/mpeg', bitrateKbps }
}

function flacOutput(action: 'copy' | 'transcode'): QualityOutputProfile {
  return { action, container: 'flac', codec: 'flac', extension: 'flac', mimeType: 'audio/flac' }
}

/**
 * Decide whether the original can be kept and which output(s) to produce.
 * Only MP3 can be passed through for lossy output; other lossy containers are
 * normalized to MP3 for browser compatibility.
 */
export function getLocalAudioQualityProfile(
  media: Pick<LocalAudioMetadata, 'container' | 'lossless' | 'bitrateKbps'>,
  quality: LocalAudioQuality,
): LocalAudioQualityProfile {
  if (quality === 999) {
    if (media.lossless) {
      return {
        requestedQuality: quality,
        primary: flacOutput(media.container === 'flac' ? 'copy' : 'transcode'),
        fallback: mp3Output('transcode', 320),
      }
    }

    // A lossy source cannot become lossless. Keep an already-valid MP3 when
    // its bitrate is known; otherwise normalize to MP3 320.
    const canCopy = media.container === 'mp3' && media.bitrateKbps !== undefined && media.bitrateKbps <= 320
    return {
      requestedQuality: quality,
      primary: mp3Output(canCopy ? 'copy' : 'transcode', canCopy ? media.bitrateKbps! : 320),
    }
  }

  const target = quality
  const canCopy = media.container === 'mp3' && media.bitrateKbps !== undefined && media.bitrateKbps <= target
  return {
    requestedQuality: quality,
    primary: mp3Output(canCopy ? 'copy' : 'transcode', canCopy ? media.bitrateKbps! : target),
  }
}

export interface TranscodeRequest {
  inputPath: string
  outputPath: string
  profile: QualityOutputProfile
  signal?: AbortSignal
  timeoutMs?: number
  /** Hard upper bound for the generated file. FFmpeg may stop at this size. */
  maxOutputBytes?: number
}

export interface CoverExtractionRequest {
  inputPath: string
  outputPath: string
  /** Pass the probe result to avoid invoking ffmpeg when no attached cover exists. */
  hasEmbeddedCover?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  maxEdge?: number
}

export interface CoverExtractionResult {
  path: string | null
  sizeBytes: number
  reason?: 'missing' | 'too_large'
}

export interface ProcessMediaRequest {
  inputPath: string
  originalName?: string
  quality: LocalAudioQuality
  primaryPath: string
  fallbackPath?: string
  coverPath?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  maxCoverBytes?: number
}

export interface ProcessMediaResult {
  metadata: LocalAudioMetadata
  profile: LocalAudioQualityProfile
  primaryPath: string
  primarySizeBytes: number
  fallbackPath?: string
  fallbackSizeBytes?: number
  coverPath?: string
  coverSizeBytes: number
}

export interface LocalAudioMediaOptions {
  probe?: ProbeExecutor
  ffmpeg?: FfmpegExecutor
  fileSystem?: MediaFileSystem
  ffprobePath?: string
  ffmpegPath?: string
  commandTimeoutMs?: number
  /** Maximum number of FFmpeg worker threads per invocation. */
  ffmpegThreads?: number
  coverMaxBytes?: number
  coverMaxEdge?: number
}

function scaleFilter(maxEdge: number): string {
  // The expression never upscales and preserves aspect ratio. FFmpeg accepts
  // this expression for images and attached-picture streams alike.
  return `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`
}

function normalizeFfmpegThreads(value: number | undefined): number {
  if (value === undefined) return LOCAL_AUDIO_MEDIA_LIMITS.defaultFfmpegThreads
  return Number.isInteger(value) && value > 0 ? value : LOCAL_AUDIO_MEDIA_LIMITS.defaultFfmpegThreads
}

export function buildTranscodeArgs(
  inputPath: string,
  outputPath: string,
  profile: QualityOutputProfile,
  options: { ffmpegThreads?: number; maxOutputBytes?: number } = {},
): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-protocol_whitelist',
    LOCAL_AUDIO_INPUT_PROTOCOL_WHITELIST,
    '-format_whitelist',
    LOCAL_AUDIO_INPUT_FORMAT_WHITELIST,
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-vn',
    '-map_metadata',
    '0',
  ]

  if (profile.container === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', `${profile.bitrateKbps ?? 320}k`, '-id3v2_version', '3')
  } else {
    args.push('-c:a', 'flac', '-compression_level', '5')
  }

  if (options.ffmpegThreads !== undefined) {
    args.push('-threads', String(options.ffmpegThreads))
  }

  // Keep an unexpectedly long or malformed input from filling the data
  // volume before the service's post-transcode quota check runs.
  if (options.maxOutputBytes !== undefined) {
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
      throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码输出上限无效')
    }
    args.push('-fs', String(options.maxOutputBytes))
  }

  args.push(outputPath)
  return args
}

export function buildCoverExtractionArgs(
  inputPath: string,
  outputPath: string,
  options: { maxEdge?: number; quality?: number; ffmpegThreads?: number } = {},
): string[] {
  const maxEdge = options.maxEdge ?? LOCAL_AUDIO_MEDIA_LIMITS.coverMaxEdge
  const quality = options.quality ?? 5
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-protocol_whitelist',
    LOCAL_AUDIO_INPUT_PROTOCOL_WHITELIST,
    '-format_whitelist',
    LOCAL_AUDIO_INPUT_FORMAT_WHITELIST,
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0?',
    '-frames:v',
    '1',
    '-vf',
    scaleFilter(maxEdge),
    '-c:v',
    'mjpeg',
    '-q:v',
    String(quality),
    ...(options.ffmpegThreads === undefined ? [] : ['-threads', String(options.ffmpegThreads)]),
    '-f',
    'image2',
    outputPath,
  ]
}

function isAbortLike(error: unknown): boolean {
  return error instanceof LocalAudioMediaError && (error.code === 'ABORTED' || error.code === 'TIMEOUT')
}

async function raceWithDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (parentSignal?.aborted) throw abortError(parentSignal.reason)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadlineError: LocalAudioMediaError | undefined
  let rejectDeadline!: (error: LocalAudioMediaError) => void
  const deadlinePromise = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  const triggerDeadline = (error: LocalAudioMediaError) => {
    if (deadlineError) return
    deadlineError = error
    controller.abort(error)
    rejectDeadline(error)
  }
  const abortForParent = () => triggerDeadline(abortError(parentSignal?.reason))
  parentSignal?.addEventListener('abort', abortForParent, { once: true })
  if (parentSignal?.aborted) abortForParent()
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => triggerDeadline(timeoutError('媒体处理', timeoutMs)), timeoutMs)
    timer.unref?.()
  }

  const taskPromise = Promise.resolve().then(() => task(controller.signal))

  try {
    return await Promise.race([taskPromise, deadlinePromise])
  } catch (error) {
    if (deadlineError) {
      // File copies cannot be cancelled by Node, and child processes release
      // their output handles only on `close`. Do not let callers remove an
      // output path until the underlying operation has genuinely settled.
      try {
        await taskPromise
      } catch {
        // The canonical parent-abort/timeout error is returned below.
      }
      throw deadlineError
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abortForParent)
    if (!controller.signal.aborted) controller.abort()
  }
}

/** Media orchestration that keeps process/filesystem boundaries injectable. */
export class LocalAudioMedia {
  private readonly probeExecutor: ProbeExecutor
  private readonly ffmpegExecutor: FfmpegExecutor
  private readonly fileSystem: MediaFileSystem
  private readonly commandTimeoutMs: number
  private readonly ffmpegThreads: number
  private readonly coverMaxBytes: number
  private readonly coverMaxEdge: number

  constructor(options: LocalAudioMediaOptions = {}) {
    const commandRunner = defaultCommandRunner
    this.probeExecutor = options.probe ?? createProbeExecutor(commandRunner, options.ffprobePath ?? 'ffprobe')
    this.ffmpegExecutor = options.ffmpeg ?? createFfmpegExecutor(commandRunner, options.ffmpegPath ?? 'ffmpeg')
    this.fileSystem = options.fileSystem ?? defaultFileSystem
    this.commandTimeoutMs = options.commandTimeoutMs ?? LOCAL_AUDIO_MEDIA_LIMITS.commandTimeoutMs
    this.ffmpegThreads = normalizeFfmpegThreads(options.ffmpegThreads)
    this.coverMaxBytes = options.coverMaxBytes ?? LOCAL_AUDIO_MEDIA_LIMITS.coverMaxBytes
    this.coverMaxEdge = options.coverMaxEdge ?? LOCAL_AUDIO_MEDIA_LIMITS.coverMaxEdge
  }

  async probeFile(
    filePath: string,
    options: { originalName?: string; sizeBytes?: number; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<LocalAudioMetadata> {
    assertLocalMediaPath(filePath, '输入文件路径')
    let raw: ProbeResult
    try {
      raw = await raceWithDeadline(
        (signal) => this.probeExecutor({ filePath, signal, timeoutMs: options.timeoutMs ?? this.commandTimeoutMs }),
        options.signal,
        options.timeoutMs ?? this.commandTimeoutMs,
      )
    } catch (error) {
      if (error instanceof LocalAudioMediaError && (error.code === 'ABORTED' || error.code === 'TIMEOUT')) throw error
      throw new LocalAudioMediaError('PROBE_FAILED', '媒体探测失败', { cause: error })
    }

    let sizeBytes = options.sizeBytes
    if (sizeBytes === undefined) {
      try {
        sizeBytes = (await this.fileSystem.stat(filePath)).size
      } catch {
        // Probe metadata is still useful when a caller supplies a virtual file.
      }
    }

    let ebmlDocType: string | undefined
    const formatNames = normalizeFormatNames(raw.format?.format_name)
    if (formatNames.includes('matroska') || formatNames.includes('webm')) {
      try {
        const header = await raceWithDeadline(
          () => this.fileSystem.readHeader(filePath, LOCAL_AUDIO_EBML_HEADER_MAX_BYTES),
          options.signal,
          options.timeoutMs ?? this.commandTimeoutMs,
        )
        ebmlDocType = parseEbmlDocType(header)
      } catch (error) {
        if (error instanceof LocalAudioMediaError && (error.code === 'ABORTED' || error.code === 'TIMEOUT')) {
          throw error
        }
        throw new LocalAudioMediaError('PROBE_FAILED', '无法读取 EBML 容器头', { cause: error })
      }
    }

    return validateLocalAudioProbe(raw, { originalName: options.originalName, sizeBytes, ebmlDocType })
  }

  async transcode(request: TranscodeRequest): Promise<void> {
    assertLocalMediaPath(request.inputPath, '输入文件路径')
    assertLocalMediaPath(request.outputPath, '输出文件路径')
    if (path.resolve(request.inputPath) !== path.resolve(request.outputPath)) {
      await assertOutputPathAbsent(request.outputPath, this.fileSystem)
    } else if (request.profile.action !== 'copy') {
      throw new LocalAudioMediaError('INVALID_MEDIA', '转码输出路径不能覆盖输入文件')
    }
    if (
      request.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0)
    ) {
      throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码输出上限无效')
    }
    if (request.profile.action === 'copy') {
      if (request.maxOutputBytes !== undefined) {
        const inputStat = await this.fileSystem.stat(request.inputPath)
        if (inputStat.size > request.maxOutputBytes) {
          throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
        }
      }
      if (path.resolve(request.inputPath) !== path.resolve(request.outputPath)) {
        await this.fileSystem.mkdir(path.dirname(request.outputPath))
        try {
          await raceWithDeadline(
            () => this.fileSystem.copyFile(request.inputPath, request.outputPath),
            request.signal,
            request.timeoutMs ?? this.commandTimeoutMs,
          )
        } catch (error) {
          await cleanupMediaPaths([request.outputPath], this.fileSystem)
          throw error
        }
      }
      return
    }

    await this.fileSystem.mkdir(path.dirname(request.outputPath))
    try {
      await raceWithDeadline(
        (signal) =>
          this.ffmpegExecutor({
            args: buildTranscodeArgs(request.inputPath, request.outputPath, request.profile, {
              ffmpegThreads: this.ffmpegThreads,
              maxOutputBytes: request.maxOutputBytes,
            }),
            signal,
            timeoutMs: request.timeoutMs ?? this.commandTimeoutMs,
          }),
        request.signal,
        request.timeoutMs ?? this.commandTimeoutMs,
      )
    } catch (error) {
      await cleanupMediaPaths([request.outputPath], this.fileSystem)
      if (isAbortLike(error)) throw error
      throw new LocalAudioMediaError('COMMAND_FAILED', '音频转码失败', { cause: error })
    }
    if (request.maxOutputBytes !== undefined) {
      const outputSize = (await this.fileSystem.stat(request.outputPath)).size
      // FFmpeg's `-fs` exits successfully after writing the packet that crosses
      // the limit. Such a file is deliberately truncated and must never be
      // published as a ready asset.
      if (outputSize >= request.maxOutputBytes) {
        await cleanupMediaPaths([request.outputPath], this.fileSystem)
        throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
      }
    }
  }

  async extractCover(request: CoverExtractionRequest): Promise<CoverExtractionResult> {
    assertLocalMediaPath(request.inputPath, '输入文件路径')
    assertLocalMediaPath(request.outputPath, '封面输出路径')
    if (request.hasEmbeddedCover === false) return { path: null, sizeBytes: 0, reason: 'missing' }
    await assertOutputPathAbsent(request.outputPath, this.fileSystem)

    const maxBytes = request.maxBytes ?? this.coverMaxBytes
    const maxEdge = request.maxEdge ?? this.coverMaxEdge
    await this.fileSystem.mkdir(path.dirname(request.outputPath))

    // Lower JPEG quality values are better quality. Retry with progressively
    // smaller files instead of allowing an oversized thumbnail to persist.
    for (const quality of [5, 8, 12, 16, 20, 25, 30]) {
      try {
        await raceWithDeadline(
          (signal) =>
            this.ffmpegExecutor({
              args: buildCoverExtractionArgs(request.inputPath, request.outputPath, {
                maxEdge,
                quality,
                ffmpegThreads: this.ffmpegThreads,
              }),
              signal,
              timeoutMs: request.timeoutMs ?? this.commandTimeoutMs,
            }),
          request.signal,
          request.timeoutMs ?? this.commandTimeoutMs,
        )
      } catch (error) {
        await cleanupMediaPaths([request.outputPath], this.fileSystem)
        if (isAbortLike(error)) throw error
        // No attached picture or an unreadable cover is non-fatal to audio.
        return { path: null, sizeBytes: 0, reason: 'missing' }
      }

      let sizeBytes: number
      try {
        sizeBytes = (await this.fileSystem.stat(request.outputPath)).size
      } catch {
        await cleanupMediaPaths([request.outputPath], this.fileSystem)
        return { path: null, sizeBytes: 0, reason: 'missing' }
      }
      if (sizeBytes > 0 && sizeBytes <= maxBytes) return { path: request.outputPath, sizeBytes }
    }

    await cleanupMediaPaths([request.outputPath], this.fileSystem)
    return { path: null, sizeBytes: 0, reason: 'too_large' }
  }

  async process(request: ProcessMediaRequest): Promise<ProcessMediaResult> {
    assertLocalMediaPath(request.inputPath, '输入文件路径')
    assertLocalMediaPath(request.primaryPath, '主音频输出路径')
    if (request.fallbackPath) assertLocalMediaPath(request.fallbackPath, 'fallback 音频输出路径')
    if (request.coverPath) assertLocalMediaPath(request.coverPath, '封面输出路径')
    const outputPaths: string[] = []
    try {
      const metadata = await this.probeFile(request.inputPath, {
        originalName: request.originalName,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      })
      const profile = getLocalAudioQualityProfile(metadata, request.quality)
      if (profile.fallback && !request.fallbackPath) {
        throw new LocalAudioMediaError('INVALID_MEDIA', '无损音频处理缺少 MP3 fallback 输出路径')
      }

      const plannedOutputs = [
        request.primaryPath,
        profile.fallback ? request.fallbackPath : undefined,
        metadata.hasEmbeddedCover ? request.coverPath : undefined,
      ].filter((value): value is string => Boolean(value))
      for (const outputPath of plannedOutputs) {
        if (path.resolve(outputPath) === path.resolve(request.inputPath)) {
          throw new LocalAudioMediaError('INVALID_MEDIA', '输出路径不能覆盖输入文件')
        }
        await assertOutputPathAbsent(outputPath, this.fileSystem)
      }
      outputPaths.push(...plannedOutputs)

      // `maxOutputBytes` covers all generated variants. Reserve the maximum
      // possible cover size before splitting the remaining budget between the
      // primary and fallback audio files.
      const coverLimit = request.maxCoverBytes ?? this.coverMaxBytes
      const reservedCoverBytes = metadata.hasEmbeddedCover && request.coverPath ? coverLimit : 0
      const audioOutputLimit =
        request.maxOutputBytes === undefined ? undefined : request.maxOutputBytes - reservedCoverBytes
      if (audioOutputLimit !== undefined && audioOutputLimit <= 0) {
        throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
      }

      await this.transcode({
        inputPath: request.inputPath,
        outputPath: request.primaryPath,
        profile: profile.primary,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: audioOutputLimit,
      })
      const primarySizeBytes = (await this.fileSystem.stat(request.primaryPath)).size
      if (audioOutputLimit !== undefined && primarySizeBytes > audioOutputLimit) {
        throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
      }

      let fallbackSizeBytes: number | undefined
      if (profile.fallback && request.fallbackPath) {
        const fallbackLimit = audioOutputLimit === undefined ? undefined : audioOutputLimit - primarySizeBytes
        if (fallbackLimit !== undefined && fallbackLimit <= 0) {
          throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
        }
        await this.transcode({
          inputPath: request.inputPath,
          outputPath: request.fallbackPath,
          profile: profile.fallback,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: fallbackLimit,
        })
        fallbackSizeBytes = (await this.fileSystem.stat(request.fallbackPath)).size
        if (audioOutputLimit !== undefined && primarySizeBytes + fallbackSizeBytes > audioOutputLimit) {
          throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '转码后的音频超过空间限制')
        }
      }

      let coverPath: string | undefined
      let coverSizeBytes = 0
      if (request.coverPath) {
        const cover = await this.extractCover({
          inputPath: request.inputPath,
          outputPath: request.coverPath,
          hasEmbeddedCover: metadata.hasEmbeddedCover,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          maxBytes: coverLimit,
        })
        coverPath = cover.path ?? undefined
        coverSizeBytes = cover.sizeBytes
      }

      const totalOutputBytes = primarySizeBytes + (fallbackSizeBytes ?? 0) + coverSizeBytes
      if (request.maxOutputBytes !== undefined && totalOutputBytes > request.maxOutputBytes) {
        throw new LocalAudioMediaError('OUTPUT_TOO_LARGE', '处理后的媒体资产超过空间限制')
      }

      return {
        metadata,
        profile,
        primaryPath: request.primaryPath,
        primarySizeBytes,
        fallbackPath: profile.fallback && request.fallbackPath ? request.fallbackPath : undefined,
        fallbackSizeBytes,
        coverPath,
        coverSizeBytes,
      }
    } catch (error) {
      await cleanupMediaPaths(outputPaths, this.fileSystem)
      throw error
    }
  }

  async cleanup(paths: readonly (string | undefined | null)[]): Promise<void> {
    await cleanupMediaPaths(paths, this.fileSystem)
  }
}

export function createLocalAudioMedia(options: LocalAudioMediaOptions = {}): LocalAudioMedia {
  return new LocalAudioMedia(options)
}

/** Remove generated files while treating already-removed paths as success. */
export async function cleanupMediaPaths(
  paths: readonly (string | undefined | null)[],
  fileSystem: MediaFileSystem = defaultFileSystem,
): Promise<void> {
  const unique = new Set(paths.filter((value): value is string => typeof value === 'string' && value.length > 0))
  await Promise.all(
    Array.from(unique, async (filePath) => {
      try {
        await fileSystem.unlink(filePath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') throw error
      }
    }),
  )
}

export interface ParsedByteRange {
  start: number
  end: number
  length: number
}

export type ByteRangeParseResult =
  | { kind: 'none' }
  | { kind: 'ok'; range: ParsedByteRange }
  | { kind: 'invalid'; contentRange: string }

/**
 * Lexically verify that a generated media path is a file below the configured
 * root. Callers that allow locally-created symlinks must additionally compare
 * `realpath` results before opening the file.
 */
export function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Parse a single RFC 9110 byte range. Multi-range requests are rejected so a
 * route can use one efficient `createReadStream` and return 416 consistently.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRangeParseResult {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'invalid', contentRange: 'bytes */0' }
  if (header === undefined || header.trim() === '') return { kind: 'none' }

  const value = header.trim()
  const unitMatch = /^bytes=(.*)$/i.exec(value)
  if (!unitMatch || unitMatch[1].includes(',')) {
    return { kind: 'invalid', contentRange: `bytes */${size}` }
  }

  const spec = unitMatch[1].trim()
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (!match || size === 0) return { kind: 'invalid', contentRange: `bytes */${size}` }

  const startText = match[1]
  const endText = match[2]
  let start: number
  let end: number

  if (startText === '') {
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: 'invalid', contentRange: `bytes */${size}` }
    }
    start = Math.max(size - suffixLength, 0)
    end = size - 1
  } else {
    start = Number(startText)
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
      return { kind: 'invalid', contentRange: `bytes */${size}` }
    }
    end = endText === '' ? size - 1 : Number(endText)
    if (!Number.isSafeInteger(end) || end < start) {
      return { kind: 'invalid', contentRange: `bytes */${size}` }
    }
    end = Math.min(end, size - 1)
  }

  return { kind: 'ok', range: { start, end, length: end - start + 1 } }
}

/** Alias with an HTTP-oriented name for route code. */
export const parseRangeHeader = parseByteRange
