import { afterEach, describe, expect, it, vi } from 'vitest'
import { join, parse, resolve } from 'node:path'

const DEV_IDENTITY_SECRET = 'dev-identity-secret-change-me'
const BYTES_PER_MIB = 1024 * 1024

async function loadConfig() {
  vi.resetModules()
  return import('./config.js')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('production identity secret validation', () => {
  it('rejects a missing secret in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('IDENTITY_SECRET', '')
    delete process.env.IDENTITY_SECRET

    await expect(loadConfig()).rejects.toThrow('IDENTITY_SECRET must be set to at least 32 characters in production')
  })

  it('rejects the published development secret in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('IDENTITY_SECRET', DEV_IDENTITY_SECRET)

    await expect(loadConfig()).rejects.toThrow('IDENTITY_SECRET must be set to at least 32 characters in production')
  })

  it('accepts an explicitly configured production secret with sufficient length', async () => {
    const secret = '0123456789abcdef0123456789abcdef'
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('IDENTITY_SECRET', secret)

    const { config } = await loadConfig()
    expect(config.identity.secret).toBe(secret)
    expect(config.isProd).toBe(true)
  })

  it('keeps the development fallback available outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('IDENTITY_SECRET', '')

    const { config } = await loadConfig()
    expect(config.identity.secret).toBe(DEV_IDENTITY_SECRET)
    expect(config.isProd).toBe(false)
  })
})

describe('local audio environment validation', () => {
  it('resolves the default directory from the process working directory', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    delete process.env.IDENTITY_SECRET

    const { config } = await loadConfig()
    expect(config.localAudio.dataDir).toBe(resolve(process.cwd(), 'data/local-audio'))
    expect(config.localAudio).toMatchObject({
      maxUploadBytes: 500 * BYTES_PER_MIB,
      roomQuotaBytes: 1024 * BYTES_PER_MIB,
      serverQuotaBytes: 2560 * BYTES_PER_MIB,
      tempQuotaBytes: 1280 * BYTES_PER_MIB,
      minFreeBytes: 1536 * BYTES_PER_MIB,
      ffprobePath: 'ffprobe',
      ffmpegPath: 'ffmpeg',
      ffprobeTimeoutMs: 30_000,
      ffmpegTimeoutMs: 21_600_000,
      accessTokenTtlMs: 86_400_000,
      ffmpegThreads: 1,
    })
  })

  it('uses defaults for blank numeric variables without disabling the disk floor', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_MIN_FREE_MIB', '   ')
    delete process.env.IDENTITY_SECRET

    const { config } = await loadConfig()
    expect(config.localAudio.minFreeBytes).toBe(1536 * BYTES_PER_MIB)
  })

  it('converts explicit MiB limits to safe byte values', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_MAX_UPLOAD_MIB', '64')
    vi.stubEnv('LOCAL_AUDIO_MIN_FREE_MIB', '0')
    delete process.env.IDENTITY_SECRET

    const { config } = await loadConfig()
    expect(config.localAudio.maxUploadBytes).toBe(64 * BYTES_PER_MIB)
    expect(config.localAudio.minFreeBytes).toBe(0)
    expect(Number.isSafeInteger(config.localAudio.maxUploadBytes)).toBe(true)
  })

  it('rejects MiB values that would overflow a safe byte integer', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_SERVER_QUOTA_MIB', '8589934592')
    delete process.env.IDENTITY_SECRET

    await expect(loadConfig()).rejects.toThrow()
  })

  it('rejects process timeouts beyond the Node.js timer range', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_FFMPEG_TIMEOUT_MS', '2147483648')
    delete process.env.IDENTITY_SECRET

    await expect(loadConfig()).rejects.toThrow()
  })

  it('rejects token lifetimes that could produce unsafe expiry timestamps', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_ACCESS_TOKEN_TTL_MS', String(Number.MAX_SAFE_INTEGER))
    delete process.env.IDENTITY_SECRET

    await expect(loadConfig()).rejects.toThrow()
  })

  it('rejects blank media executable paths', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_FFMPEG_PATH', '   ')
    delete process.env.IDENTITY_SECRET

    await expect(loadConfig()).rejects.toThrow()
  })

  it.each(['.', '..'])('rejects %s when it contains the service working directory', async (dataDir) => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('LOCAL_AUDIO_DATA_DIR', dataDir)
    delete process.env.IDENTITY_SECRET

    await expect(loadConfig()).rejects.toThrow('LOCAL_AUDIO_DATA_DIR must be a dedicated directory')
  })

  it('rejects filesystem roots but accepts a dedicated data-disk directory', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    delete process.env.IDENTITY_SECRET
    const { resolveLocalAudioDataDir } = await loadConfig()
    const filesystemRoot = parse(process.cwd()).root
    const dedicatedDataDir = join(filesystemRoot, 'data', 'local-audio')

    expect(() => resolveLocalAudioDataDir(filesystemRoot)).toThrow('LOCAL_AUDIO_DATA_DIR must not be a filesystem root')
    expect(resolveLocalAudioDataDir(dedicatedDataDir)).toBe(dedicatedDataDir)
  })
})
