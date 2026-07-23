import 'dotenv/config'
import * as z from 'zod/v4'
import { TIMING } from '@music-together/shared'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'))
const DEV_IDENTITY_SECRET = 'dev-identity-secret-change-me'
const BYTES_PER_MIB = 1024 * 1024
const MAX_SAFE_MIB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MIB)
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_SAFE_TOKEN_TTL_MS = Math.floor(Number.MAX_SAFE_INTEGER / 2)

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim().length === 0 ? undefined : value
}

function positiveIntegerFromEnv(defaultValue: number, maximum = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(blankToUndefined, z.coerce.number().int().positive().max(maximum).default(defaultValue))
}

function nonnegativeIntegerFromEnv(defaultValue: number, maximum = Number.MAX_SAFE_INTEGER) {
  return z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().max(maximum).default(defaultValue))
}

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  CLIENT_URL: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),
  IDENTITY_SECRET: z.preprocess(blankToUndefined, z.string().trim().min(16).optional()),
  IDENTITY_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REJOIN_TTL_MS: z.coerce.number().int().positive().default(TIMING.ROOM_GRACE_PERIOD_MS),
  IDENTITY_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  AUTO_FALLBACK_ENABLED: z.enum(['true', 'false']).default('true'),
  LOCAL_AUDIO_DATA_DIR: z.string().trim().min(1).default('./data/local-audio'),
  LOCAL_AUDIO_MAX_UPLOAD_MIB: positiveIntegerFromEnv(500, MAX_SAFE_MIB),
  LOCAL_AUDIO_ROOM_QUOTA_MIB: positiveIntegerFromEnv(1024, MAX_SAFE_MIB),
  LOCAL_AUDIO_SERVER_QUOTA_MIB: positiveIntegerFromEnv(2560, MAX_SAFE_MIB),
  LOCAL_AUDIO_TEMP_QUOTA_MIB: positiveIntegerFromEnv(1280, MAX_SAFE_MIB),
  LOCAL_AUDIO_MIN_FREE_MIB: nonnegativeIntegerFromEnv(1536, MAX_SAFE_MIB),
  LOCAL_AUDIO_FFPROBE_PATH: z.string().trim().min(1).default('ffprobe'),
  LOCAL_AUDIO_FFMPEG_PATH: z.string().trim().min(1).default('ffmpeg'),
  LOCAL_AUDIO_FFPROBE_TIMEOUT_MS: positiveIntegerFromEnv(30_000, MAX_TIMER_DELAY_MS),
  LOCAL_AUDIO_FFMPEG_TIMEOUT_MS: positiveIntegerFromEnv(21_600_000, MAX_TIMER_DELAY_MS),
  // A 24-hour token covers long recordings and later HTTP range/seek requests.
  LOCAL_AUDIO_ACCESS_TOKEN_TTL_MS: positiveIntegerFromEnv(86_400_000, MAX_SAFE_TOKEN_TTL_MS),
  LOCAL_AUDIO_FFMPEG_THREADS: positiveIntegerFromEnv(1),
})

const env = envSchema.parse(process.env)
const isProd = process.env.NODE_ENV === 'production'

export function resolveIdentitySecret(value: string | undefined, production: boolean): string {
  if (production && (!value || value.length < 32)) {
    throw new Error('IDENTITY_SECRET must be set to at least 32 characters in production')
  }
  return value ?? DEV_IDENTITY_SECRET
}

export function resolveLocalAudioDataDir(value: string, workingDirectory = process.cwd()): string {
  const cwd = resolve(workingDirectory)
  const dataDir = resolve(cwd, value)
  if (dataDir === parse(dataDir).root) {
    throw new Error('LOCAL_AUDIO_DATA_DIR must not be a filesystem root')
  }
  const cwdFromDataDir = relative(dataDir, cwd)
  const dataDirContainsWorkingDirectory =
    cwdFromDataDir === '' ||
    (cwdFromDataDir !== '..' && !cwdFromDataDir.startsWith(`..${sep}`) && !isAbsolute(cwdFromDataDir))

  if (dataDirContainsWorkingDirectory) {
    throw new Error(
      'LOCAL_AUDIO_DATA_DIR must be a dedicated directory, not the service working directory or its parent',
    )
  }
  return dataDir
}

const identitySecret = resolveIdentitySecret(env.IDENTITY_SECRET, isProd)
const explicitOrigins = [env.CLIENT_URL, ...env.CORS_ORIGINS.split(',')].map((origin) => origin.trim()).filter(Boolean)

export const config = {
  version: rootPkg.version as string,
  port: env.PORT,
  isProd,
  clientUrl: explicitOrigins[0] ?? 'auto',
  explicitOrigins,
  room: {
    gracePeriodMs: TIMING.ROOM_GRACE_PERIOD_MS,
  },
  player: {
    nextDebounceMs: TIMING.PLAYER_NEXT_DEBOUNCE_MS,
  },
  identity: {
    secret: identitySecret,
    ttlDays: env.IDENTITY_TTL_DAYS,
    cookieSecure: env.IDENTITY_COOKIE_SECURE ? env.IDENTITY_COOKIE_SECURE === 'true' : null,
  },
  rejoin: {
    ttlMs: env.REJOIN_TTL_MS,
  },
  autoFallback: {
    enabled: env.AUTO_FALLBACK_ENABLED === 'true',
  },
  localAudio: {
    dataDir: resolveLocalAudioDataDir(env.LOCAL_AUDIO_DATA_DIR),
    maxUploadBytes: env.LOCAL_AUDIO_MAX_UPLOAD_MIB * BYTES_PER_MIB,
    roomQuotaBytes: env.LOCAL_AUDIO_ROOM_QUOTA_MIB * BYTES_PER_MIB,
    serverQuotaBytes: env.LOCAL_AUDIO_SERVER_QUOTA_MIB * BYTES_PER_MIB,
    tempQuotaBytes: env.LOCAL_AUDIO_TEMP_QUOTA_MIB * BYTES_PER_MIB,
    minFreeBytes: env.LOCAL_AUDIO_MIN_FREE_MIB * BYTES_PER_MIB,
    ffprobePath: env.LOCAL_AUDIO_FFPROBE_PATH,
    ffmpegPath: env.LOCAL_AUDIO_FFMPEG_PATH,
    ffprobeTimeoutMs: env.LOCAL_AUDIO_FFPROBE_TIMEOUT_MS,
    ffmpegTimeoutMs: env.LOCAL_AUDIO_FFMPEG_TIMEOUT_MS,
    accessTokenTtlMs: env.LOCAL_AUDIO_ACCESS_TOKEN_TTL_MS,
    ffmpegThreads: env.LOCAL_AUDIO_FFMPEG_THREADS,
  },
} as const
