import type { ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  LocalAudioMedia,
  LocalAudioMediaError,
  buildCoverExtractionArgs,
  buildTranscodeArgs,
  createCommandRunner,
  createProbeExecutor,
  getLocalAudioQualityProfile,
  isPathInsideRoot,
  parseByteRange,
  parseEbmlDocType,
  sanitizeLocalAudioMetadata,
  validateLocalAudioProbe,
  type MediaFileSystem,
  type ProbeRequest,
  type ProbeResult,
} from './localAudioMedia.js'
import {
  issueLocalAudioAccessToken,
  issueLocalAudioAccessTokenAt,
  verifyLocalAudioAccessToken,
} from './localAudioAccess.js'

function probe(formatName: string, codecName: string, overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    streams: [
      {
        codec_type: 'audio',
        codec_name: codecName,
        bit_rate: '192000',
        duration: '123.5',
        sample_rate: '48000',
        channels: 2,
        tags: { title: 'Tagged title', artist: 'Artist A;Artist B', album: 'Tagged album' },
      },
    ],
    format: { format_name: formatName, duration: '123.5', size: '12345' },
    ...overrides,
  }
}

// Captured from real FFmpeg-generated WebM and Matroska files. Both are
// reported by ffprobe as `matroska,webm`; the EBML DocType bytes differ.
const WEBM_EBML_HEADER = Buffer.from('1A45DFA39F4286810142F7810142F2810442F381084282847765626D4287810442858102', 'hex')
const MATROSKA_EBML_HEADER = Buffer.from(
  '1A45DFA3A34286810142F7810142F2810442F381084282886D6174726F736B614287810442858102',
  'hex',
)

describe('validateLocalAudioProbe', () => {
  it.each([
    ['mp3', 'mp3', 'mp3'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'aac', 'm4a/aac'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'alac', 'm4a/alac'],
    ['flac', 'flac', 'flac'],
    ['wav', 'pcm_s16le', 'wav/pcm'],
    ['wav', 'pcm_f32le', 'wav/float'],
    ['aiff', 'pcm_s16be', 'aiff/pcm'],
    ['aiff', 'pcm_f32be', 'aiff/float'],
    ['ogg', 'vorbis', 'ogg/vorbis'],
    ['ogg', 'opus', 'ogg/opus'],
    ['matroska,webm', 'vorbis', 'webm/vorbis'],
    ['matroska,webm', 'opus', 'webm/opus'],
  ])('accepts %s/%s', (formatName, codecName, expectedFormat) => {
    const result = validateLocalAudioProbe(probe(formatName, codecName), {
      originalName: 'upload.bin',
      ebmlDocType: expectedFormat.startsWith('webm/') ? 'webm' : undefined,
    })
    expect(result.format).toBe(expectedFormat)
    expect(result.title).toBe('Tagged title')
    expect(result.artist).toEqual(['Artist A', 'Artist B'])
    expect(result.durationSeconds).toBe(123.5)
    expect(result.bitrateKbps).toBe(192)
  })

  it.each([
    ['audio/midi', 'midi'],
    ['asf', 'wmav2'],
    ['ape', 'ape'],
    ['matroska', 'opus'],
    ['matroska', 'vorbis'],
    ['wav', 'pcm_mulaw'],
  ])('rejects unsupported media %s/%s', (formatName, codecName) => {
    expect(() => validateLocalAudioProbe(probe(formatName, codecName))).toThrowError(LocalAudioMediaError)
  })

  it('rejects a file containing a real video stream but permits an attached cover', () => {
    expect(() =>
      validateLocalAudioProbe(
        probe('mp3', 'mp3', {
          streams: [
            { codec_type: 'audio', codec_name: 'mp3' },
            { codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
          ],
        }),
      ),
    ).toThrowError(/视频/)

    const result = validateLocalAudioProbe(
      probe('mp3', 'mp3', {
        streams: [
          { codec_type: 'audio', codec_name: 'mp3' },
          { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        ],
      }),
    )
    expect(result.hasEmbeddedCover).toBe(true)
  })

  it('uses safe metadata fallbacks and strips control characters', () => {
    const result = sanitizeLocalAudioMetadata({ title: '\u0000\n', artist: '', album: '\t' }, '  live-recording.wav  ')
    expect(result).toEqual({ title: 'live-recording', artist: ['未知艺术家'], album: '本地音乐' })
  })

  it('requires the actual EBML DocType to accept WebM and rejects Matroska with the same ffprobe name', () => {
    expect(validateLocalAudioProbe(probe('matroska,webm', 'opus'), { ebmlDocType: 'webm' }).format).toBe('webm/opus')
    expect(() => validateLocalAudioProbe(probe('matroska,webm', 'opus'), { ebmlDocType: 'matroska' })).toThrowError(
      LocalAudioMediaError,
    )
    expect(() => validateLocalAudioProbe(probe('matroska,webm', 'opus'))).toThrowError(LocalAudioMediaError)
  })
})

describe('parseEbmlDocType', () => {
  it('distinguishes real WebM and Matroska EBML headers', () => {
    expect(parseEbmlDocType(WEBM_EBML_HEADER)).toBe('webm')
    expect(parseEbmlDocType(MATROSKA_EBML_HEADER)).toBe('matroska')
  })

  it('does not accept a forged DocType outside the bounded EBML header', () => {
    const withoutDocType = Buffer.from('1A45DFA38442868101', 'hex')
    const forgedTail = Buffer.from('4282847765626D', 'hex')
    expect(parseEbmlDocType(Buffer.concat([withoutDocType, forgedTail]))).toBeUndefined()
    expect(parseEbmlDocType(Buffer.from('not ebml'))).toBeUndefined()
  })

  it('rejects ambiguous EBML headers containing duplicate DocType elements', () => {
    const duplicateDocTypes = Buffer.from('1A45DFA3924282847765626D4282886D6174726F736B61', 'hex')
    expect(parseEbmlDocType(duplicateDocTypes)).toBeUndefined()
  })
})

describe('getLocalAudioQualityProfile', () => {
  it('keeps an MP3 that is already within the requested lossy quality', () => {
    expect(getLocalAudioQualityProfile({ container: 'mp3', lossless: false, bitrateKbps: 128 }, 192)).toMatchObject({
      primary: { action: 'copy', bitrateKbps: 128 },
    })
  })

  it('reports the original bitrate when a lower quality MP3 is copied', () => {
    expect(getLocalAudioQualityProfile({ container: 'mp3', lossless: false, bitrateKbps: 160 }, 999)).toMatchObject({
      requestedQuality: 999,
      primary: { action: 'copy', bitrateKbps: 160 },
    })
  })

  it('transcodes higher bitrate MP3 instead of silently retaining it', () => {
    expect(getLocalAudioQualityProfile({ container: 'mp3', lossless: false, bitrateKbps: 320 }, 128)).toMatchObject({
      primary: { action: 'transcode', bitrateKbps: 128 },
    })
  })

  it('normalizes non-MP3 lossy input to MP3', () => {
    expect(getLocalAudioQualityProfile({ container: 'ogg', lossless: false, bitrateKbps: 96 }, 192)).toMatchObject({
      primary: { action: 'transcode', container: 'mp3', bitrateKbps: 192 },
    })
  })

  it('keeps lossless primary output and creates a 320k MP3 fallback for quality 999', () => {
    expect(getLocalAudioQualityProfile({ container: 'flac', lossless: true }, 999)).toEqual({
      requestedQuality: 999,
      primary: expect.objectContaining({ action: 'copy', container: 'flac' }),
      fallback: expect.objectContaining({ action: 'transcode', container: 'mp3', bitrateKbps: 320 }),
    })
  })

  it('transcodes lossy input to MP3 320 when quality 999 is requested', () => {
    expect(
      getLocalAudioQualityProfile({ container: 'aac' as never, lossless: false, bitrateKbps: 128 }, 999),
    ).toMatchObject({
      primary: { action: 'transcode', container: 'mp3', bitrateKbps: 320 },
    })
  })
})

describe('command argument builders', () => {
  it('restricts ffprobe to local files and supported demuxers before parsing input', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const probeExecutor = createProbeExecutor(async (command, args) => {
      calls.push({ command, args })
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(probe('mp3', 'mp3')),
        stderr: '',
      }
    })

    await probeExecutor({ filePath: 'C:\\uploads with spaces\\input.mp3', timeoutMs: 1_000 })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('ffprobe')
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mp3,mov,flac,wav,aiff,ogg,matroska',
      ]),
    )
    expect(calls[0]?.args.at(-1)).toBe('C:\\uploads with spaces\\input.mp3')
  })

  it('uses argument arrays and maps only the audio stream', () => {
    const args = buildTranscodeArgs('C:\\uploads\\input;touch', '/data/out.mp3', {
      action: 'transcode',
      container: 'mp3',
      codec: 'mp3',
      extension: 'mp3',
      mimeType: 'audio/mpeg',
      bitrateKbps: 320,
    })
    expect(args).toContain('-map')
    expect(args).toContain('0:a:0')
    expect(args.at(-1)).toBe('/data/out.mp3')
    expect(args).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mp3,mov,flac,wav,aiff,ogg,matroska',
      ]),
    )

    const coverArgs = buildCoverExtractionArgs('/tmp/in', '/tmp/cover.jpg')
    expect(coverArgs).toContain('0:v:0?')
    expect(coverArgs).toEqual(
      expect.arrayContaining([
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mp3,mov,flac,wav,aiff,ogg,matroska',
      ]),
    )
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-format_whitelist')).toBeLessThan(args.indexOf('-i'))
    expect(coverArgs.indexOf('-protocol_whitelist')).toBeLessThan(coverArgs.indexOf('-i'))
    expect(coverArgs.indexOf('-format_whitelist')).toBeLessThan(coverArgs.indexOf('-i'))
  })

  it('applies the configured FFmpeg thread limit to audio and cover outputs', () => {
    const profile = {
      action: 'transcode' as const,
      container: 'mp3' as const,
      codec: 'mp3' as const,
      extension: 'mp3' as const,
      mimeType: 'audio/mpeg' as const,
      bitrateKbps: 192,
    }

    expect(buildTranscodeArgs('/tmp/in.flac', '/tmp/out.mp3', profile, { ffmpegThreads: 2 })).toEqual(
      expect.arrayContaining(['-threads', '2']),
    )
    expect(buildCoverExtractionArgs('/tmp/in.flac', '/tmp/cover.jpg', { ffmpegThreads: 2 })).toEqual(
      expect.arrayContaining(['-threads', '2']),
    )
  })

  it('applies a hard FFmpeg output-size limit', () => {
    const args = buildTranscodeArgs(
      '/tmp/in.flac',
      '/tmp/out.mp3',
      {
        action: 'transcode',
        container: 'mp3',
        codec: 'mp3',
        extension: 'mp3',
        mimeType: 'audio/mpeg',
        bitrateKbps: 320,
      },
      { maxOutputBytes: 123_456 },
    )

    expect(args).toEqual(expect.arrayContaining(['-fs', '123456']))
    expect(args.at(-1)).toBe('/tmp/out.mp3')
  })
})

function fakeCommandChild() {
  const events = new EventEmitter()
  const kill = vi.fn(() => true)
  const child = Object.assign(events, {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
  }) as unknown as ChildProcessByStdio<null, Readable, Readable>

  return { child, events, kill }
}

describe('createCommandRunner', () => {
  it('kills an aborted child and waits for close before rejecting', async () => {
    const { child, events, kill } = fakeCommandChild()
    const runner = createCommandRunner(() => child)
    const controller = new AbortController()
    let outcome: { ok: true } | { ok: false; error: unknown } | undefined
    const observed = runner('ffmpeg', [], { signal: controller.signal, timeoutMs: 0 }).then(
      () => {
        outcome = { ok: true }
      },
      (error: unknown) => {
        outcome = { ok: false, error }
      },
    )

    controller.abort('upload cancelled')
    await Promise.resolve()

    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(outcome).toBeUndefined()

    events.emit('close', null, 'SIGKILL')
    await observed

    expect(outcome).toMatchObject({ ok: false, error: { code: 'ABORTED' } })
  })

  it('kills a timed-out child and waits for close before rejecting', async () => {
    vi.useFakeTimers()
    try {
      const { child, events, kill } = fakeCommandChild()
      const runner = createCommandRunner(() => child)
      let outcome: { ok: true } | { ok: false; error: unknown } | undefined
      const observed = runner('ffmpeg', [], { timeoutMs: 25 }).then(
        () => {
          outcome = { ok: true }
        },
        (error: unknown) => {
          outcome = { ok: false, error }
        },
      )

      await vi.advanceTimersByTimeAsync(25)

      expect(kill).toHaveBeenCalledOnce()
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      expect(outcome).toBeUndefined()

      events.emit('close', null, 'SIGKILL')
      await observed

      expect(outcome).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseByteRange', () => {
  it('handles absent, normal, open-ended, and suffix ranges', () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ kind: 'ok', range: { start: 10, end: 19, length: 10 } })
    expect(parseByteRange('bytes=10-', 100)).toEqual({ kind: 'ok', range: { start: 10, end: 99, length: 90 } })
    expect(parseByteRange('bytes=-10', 100)).toEqual({ kind: 'ok', range: { start: 90, end: 99, length: 10 } })
  })

  it('clamps an end beyond the file and rejects malformed/multi ranges', () => {
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ kind: 'ok', range: { start: 90, end: 99, length: 10 } })
    expect(parseByteRange('bytes=1-2,4-5', 100)).toMatchObject({ kind: 'invalid', contentRange: 'bytes */100' })
    expect(parseByteRange('bytes=100-101', 100)).toMatchObject({ kind: 'invalid', contentRange: 'bytes */100' })
    expect(parseByteRange('bytes=-0', 100)).toMatchObject({ kind: 'invalid' })
  })

  it('handles full suffixes and rejects unsafe numeric or unit syntax', () => {
    expect(parseByteRange('BYTES=-200', 100)).toEqual({ kind: 'ok', range: { start: 0, end: 99, length: 100 } })
    expect(parseByteRange('items=0-1', 100)).toEqual({ kind: 'invalid', contentRange: 'bytes */100' })
    expect(parseByteRange('bytes=0-9007199254740992', 100)).toEqual({
      kind: 'invalid',
      contentRange: 'bytes */100',
    })
    expect(parseByteRange(undefined, Number.NaN)).toEqual({ kind: 'invalid', contentRange: 'bytes */0' })
    expect(parseByteRange('bytes=0-0', 0)).toEqual({ kind: 'invalid', contentRange: 'bytes */0' })
  })
})

describe('media path containment', () => {
  it('accepts descendants but rejects the root, siblings, and traversal', () => {
    const root = path.resolve('/data/local-audio')
    expect(isPathInsideRoot(root, path.join(root, 'assets', 'room', 'asset', 'primary.mp3'))).toBe(true)
    expect(isPathInsideRoot(root, root)).toBe(false)
    expect(isPathInsideRoot(root, path.resolve(root, '..', 'local-audio-elsewhere', 'primary.mp3'))).toBe(false)
    expect(isPathInsideRoot(root, path.join(root, '..', 'secret.mp3'))).toBe(false)
  })
})

describe('local audio access tokens', () => {
  it('supports one explicit expiry shared by every URL in a track', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const token = issueLocalAudioAccessTokenAt('room-a', 'asset-a', 'primary', 5_000)
      now.mockReturnValue(4_999)
      expect(verifyLocalAudioAccessToken(token, { roomId: 'room-a', assetId: 'asset-a', variant: 'primary' })).toBe(
        true,
      )
      now.mockReturnValue(5_000)
      expect(verifyLocalAudioAccessToken(token, { roomId: 'room-a', assetId: 'asset-a', variant: 'primary' })).toBe(
        false,
      )
    } finally {
      now.mockRestore()
    }
  })

  it('binds a token to the exact room, asset, and variant', () => {
    const token = issueLocalAudioAccessToken('room-a', 'asset-a', 'primary', 60_000)
    expect(verifyLocalAudioAccessToken(token, { roomId: 'room-a', assetId: 'asset-a', variant: 'primary' })).toBe(true)
    expect(verifyLocalAudioAccessToken(token, { roomId: 'room-b', assetId: 'asset-a', variant: 'primary' })).toBe(false)
    expect(verifyLocalAudioAccessToken(token, { roomId: 'room-a', assetId: 'asset-b', variant: 'primary' })).toBe(false)
    expect(verifyLocalAudioAccessToken(token, { roomId: 'room-a', assetId: 'asset-a', variant: 'fallback' })).toBe(
      false,
    )
  })

  it('rejects expired, tampered, malformed, and oversized tokens', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const token = issueLocalAudioAccessToken('room-a', 'asset-a', 'cover', 100)
      const separator = token.indexOf('.')
      const payload = token.slice(0, separator)
      const signature = token.slice(separator + 1)
      const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
      expect(
        verifyLocalAudioAccessToken(`${payload}.${tamperedSignature}`, {
          roomId: 'room-a',
          assetId: 'asset-a',
          variant: 'cover',
        }),
      ).toBe(false)
      expect(
        verifyLocalAudioAccessToken('not.base64url.signature', {
          roomId: 'room-a',
          assetId: 'asset-a',
          variant: 'cover',
        }),
      ).toBe(false)
      expect(
        verifyLocalAudioAccessToken('x'.repeat(2049), {
          roomId: 'room-a',
          assetId: 'asset-a',
          variant: 'cover',
        }),
      ).toBe(false)

      now.mockReturnValue(1_100)
      expect(verifyLocalAudioAccessToken(token, { roomId: 'room-a', assetId: 'asset-a', variant: 'cover' })).toBe(false)
    } finally {
      now.mockRestore()
    }
  })
})

function fakeFileSystem(
  initial: Record<string, number> = {},
  headers: Record<string, Buffer> = {},
): MediaFileSystem & { files: Map<string, number> } {
  const files = new Map(Object.entries(initial))
  const fileHeaders = new Map(Object.entries(headers))
  return {
    files,
    async stat(filePath) {
      const size = files.get(filePath)
      if (size === undefined) Object.assign(new Error('missing'), { code: 'ENOENT' })
      if (size === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { size }
    },
    async readHeader(filePath, maxBytes) {
      const header = fileHeaders.get(filePath)
      if (!header) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return header.subarray(0, maxBytes)
    },
    async copyFile(source, destination) {
      const size = files.get(source)
      if (size === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      files.set(destination, size)
    },
    async mkdir() {},
    async unlink(filePath) {
      files.delete(filePath)
    },
  }
}

describe('LocalAudioMedia', () => {
  it('rejects non-local paths before invoking ffprobe or ffmpeg', async () => {
    const probeExecutor = vi.fn(async () => probe('mp3', 'mp3'))
    const ffmpeg = vi.fn(async () => undefined)
    const media = new LocalAudioMedia({ probe: probeExecutor, ffmpeg })

    await expect(media.probeFile('http://example.test/audio.mp3')).rejects.toMatchObject({ code: 'INVALID_MEDIA' })
    await expect(
      media.transcode({
        inputPath: '/tmp/input.mp3',
        outputPath: 'relative/output.mp3',
        profile: {
          action: 'transcode',
          container: 'mp3',
          codec: 'mp3',
          extension: 'mp3',
          mimeType: 'audio/mpeg',
          bitrateKbps: 320,
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA' })
    expect(probeExecutor).not.toHaveBeenCalled()
    expect(ffmpeg).not.toHaveBeenCalled()
  })

  it('supports injected probe/ffmpeg/filesystem boundaries without spawning processes', async () => {
    const fs = fakeFileSystem({ '/tmp/input.mp3': 10 })
    const ffmpeg = vi.fn(async ({ args }: { args: readonly string[] }) => {
      fs.files.set(args.at(-1)!, 20)
    })
    const media = new LocalAudioMedia({
      fileSystem: fs,
      probe: vi.fn(async () => probe('mp3', 'mp3')),
      ffmpeg,
      ffmpegThreads: 2,
    })

    const result = await media.process({
      inputPath: '/tmp/input.mp3',
      originalName: 'input.mp3',
      quality: 128,
      primaryPath: '/tmp/output.mp3',
      coverPath: '/tmp/cover.jpg',
    })

    expect(result.metadata.format).toBe('mp3')
    expect(result.primaryPath).toBe('/tmp/output.mp3')
    expect(result.primarySizeBytes).toBe(20)
    expect(ffmpeg).toHaveBeenCalledOnce()
    expect(ffmpeg.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(['-threads', '2']))
  })

  it('uses the EBML DocType instead of the filename to distinguish WebM from Matroska', async () => {
    const fs = fakeFileSystem(
      {
        '/tmp/disguised-as-bin.dat': WEBM_EBML_HEADER.length,
        '/tmp/disguised-as-webm.webm': MATROSKA_EBML_HEADER.length,
      },
      {
        '/tmp/disguised-as-bin.dat': WEBM_EBML_HEADER,
        '/tmp/disguised-as-webm.webm': MATROSKA_EBML_HEADER,
      },
    )
    const media = new LocalAudioMedia({
      fileSystem: fs,
      probe: vi.fn(async () => probe('matroska,webm', 'opus')),
    })

    await expect(media.probeFile('/tmp/disguised-as-bin.dat')).resolves.toMatchObject({ format: 'webm/opus' })
    await expect(media.probeFile('/tmp/disguised-as-webm.webm')).rejects.toMatchObject({ code: 'INVALID_MEDIA' })
  })

  it('limits a fallback to the aggregate budget left by the primary output', async () => {
    const fs = fakeFileSystem({ '/tmp/input.flac': 10 })
    const ffmpeg = vi.fn(async ({ args }: { args: readonly string[] }) => {
      fs.files.set(args.at(-1)!, 80)
    })
    const media = new LocalAudioMedia({
      fileSystem: fs,
      probe: vi.fn(async () => probe('flac', 'flac')),
      ffmpeg,
    })

    const result = await media.process({
      inputPath: '/tmp/input.flac',
      quality: 999,
      primaryPath: '/tmp/primary.flac',
      fallbackPath: '/tmp/fallback.mp3',
      maxOutputBytes: 100,
    })

    expect(result.primarySizeBytes).toBe(10)
    expect(result.fallbackSizeBytes).toBe(80)
    expect(ffmpeg.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(['-fs', '90']))
  })

  it('rejects and removes an FFmpeg output that reached the hard size limit', async () => {
    const fs = fakeFileSystem({ '/tmp/input.flac': 10 })
    const media = new LocalAudioMedia({
      fileSystem: fs,
      probe: vi.fn(async () => probe('flac', 'flac')),
      ffmpeg: vi.fn(async ({ args }: { args: readonly string[] }) => {
        fs.files.set(args.at(-1)!, 101)
      }),
    })

    await expect(
      media.transcode({
        inputPath: '/tmp/input.flac',
        outputPath: '/tmp/output.mp3',
        profile: {
          action: 'transcode',
          container: 'mp3',
          codec: 'mp3',
          extension: 'mp3',
          mimeType: 'audio/mpeg',
          bitrateKbps: 320,
        },
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
    expect(fs.files.has('/tmp/output.mp3')).toBe(false)
  })

  it('cleans generated output when a later stage fails', async () => {
    const fs = fakeFileSystem({ '/tmp/input.flac': 10 })
    const media = new LocalAudioMedia({
      fileSystem: fs,
      probe: vi.fn(async () => probe('flac', 'flac')),
      ffmpeg: vi.fn(async () => {
        throw new Error('fallback failed')
      }),
    })

    await expect(
      media.process({
        inputPath: '/tmp/input.flac',
        quality: 999,
        primaryPath: '/tmp/primary.flac',
        fallbackPath: '/tmp/fallback.mp3',
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' })
    expect(fs.files.has('/tmp/primary.flac')).toBe(false)
    expect(fs.files.has('/tmp/fallback.mp3')).toBe(false)
    expect(fs.files.has('/tmp/input.flac')).toBe(true)
  })

  it('does not overwrite or remove an existing output path', async () => {
    const fs = fakeFileSystem({ '/tmp/input.mp3': 10, '/tmp/output.mp3': 99 })
    const media = new LocalAudioMedia({
      fileSystem: fs,
      probe: vi.fn(async () => probe('mp3', 'mp3')),
      ffmpeg: vi.fn(async () => undefined),
    })

    await expect(
      media.process({
        inputPath: '/tmp/input.mp3',
        quality: 128,
        primaryPath: '/tmp/output.mp3',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA' })
    expect(fs.files.get('/tmp/output.mp3')).toBe(99)
    expect(fs.files.get('/tmp/input.mp3')).toBe(10)
  })

  it('returns TIMEOUT when an injected executor does not finish', async () => {
    const media = new LocalAudioMedia({
      commandTimeoutMs: 10,
      probe: vi.fn(
        ({ signal }: ProbeRequest) =>
          new Promise<ProbeResult>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      ),
    })
    await expect(media.probeFile('/tmp/input')).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('waits for a timed-out copy to finish before removing its destination', async () => {
    vi.useFakeTimers()
    try {
      const fs = fakeFileSystem({ '/tmp/input.mp3': 10 })
      let releaseCopy!: () => void
      let markCopyStarted!: () => void
      const copyGate = new Promise<void>((resolve) => {
        releaseCopy = resolve
      })
      const copyStarted = new Promise<void>((resolve) => {
        markCopyStarted = resolve
      })
      const unlink = vi.fn(fs.unlink.bind(fs))
      fs.unlink = unlink
      fs.copyFile = vi.fn(async (source, destination) => {
        markCopyStarted()
        await copyGate
        const size = fs.files.get(source)
        if (size === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        fs.files.set(destination, size)
      })
      const media = new LocalAudioMedia({ fileSystem: fs, commandTimeoutMs: 10 })
      let outcome: { ok: true } | { ok: false; error: unknown } | undefined
      const observed = media
        .transcode({
          inputPath: '/tmp/input.mp3',
          outputPath: '/tmp/output.mp3',
          profile: {
            action: 'copy',
            container: 'mp3',
            codec: 'mp3',
            extension: 'mp3',
            mimeType: 'audio/mpeg',
            bitrateKbps: 128,
          },
        })
        .then(
          () => {
            outcome = { ok: true }
          },
          (error: unknown) => {
            outcome = { ok: false, error }
          },
        )

      await copyStarted
      await vi.advanceTimersByTimeAsync(10)

      expect(outcome).toBeUndefined()
      expect(unlink).not.toHaveBeenCalled()
      expect(fs.files.has('/tmp/output.mp3')).toBe(false)

      releaseCopy()
      await observed

      expect(outcome).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } })
      expect(unlink).toHaveBeenCalledWith('/tmp/output.mp3')
      expect(fs.files.has('/tmp/output.mp3')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
