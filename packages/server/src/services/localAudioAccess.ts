import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

export type LocalAudioAccessVariant = 'primary' | 'fallback' | 'cover'

interface AccessPayload {
  roomId: string
  assetId: string
  variant: LocalAudioAccessVariant
  expiresAt: number
}

const ACCESS_TOKEN_MAX_LENGTH = 2048
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function signature(payload: string): string {
  return createHmac('sha256', config.identity.secret).update(`local-audio:${payload}`).digest('base64url')
}

function issueTokenAt(roomId: string, assetId: string, variant: LocalAudioAccessVariant, expiresAt: number): string {
  const payload = encode(JSON.stringify({ roomId, assetId, variant, expiresAt } satisfies AccessPayload))
  return `${payload}.${signature(payload)}`
}

/** Issue a token with an explicit expiry so all URLs in one Track share it. */
export function issueLocalAudioAccessTokenAt(
  roomId: string,
  assetId: string,
  variant: LocalAudioAccessVariant,
  expiresAt: number,
): string {
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid local audio access expiry')
  return issueTokenAt(roomId, assetId, variant, expiresAt)
}

export function issueLocalAudioAccessToken(
  roomId: string,
  assetId: string,
  variant: LocalAudioAccessVariant,
  ttlMs = config.localAudio.accessTokenTtlMs,
): string {
  return issueTokenAt(roomId, assetId, variant, Date.now() + ttlMs)
}

export function verifyLocalAudioAccessToken(
  token: string | undefined,
  expected: Pick<AccessPayload, 'roomId' | 'assetId' | 'variant'>,
): boolean {
  if (!token || token.length > ACCESS_TOKEN_MAX_LENGTH) return false
  const [payload, suppliedSignature, ...rest] = token.split('.')
  if (!payload || !suppliedSignature || rest.length > 0) return false
  if (!BASE64URL_PATTERN.test(payload) || !BASE64URL_PATTERN.test(suppliedSignature)) return false

  const expectedSignature = signature(payload)
  if (suppliedSignature.length !== expectedSignature.length) return false
  const expectedBuffer = Buffer.from(expectedSignature)
  const suppliedBuffer = Buffer.from(suppliedSignature)
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) return false

  try {
    const parsed = JSON.parse(decode(payload)) as Partial<AccessPayload>
    return (
      parsed.roomId === expected.roomId &&
      parsed.assetId === expected.assetId &&
      parsed.variant === expected.variant &&
      typeof parsed.expiresAt === 'number' &&
      Number.isSafeInteger(parsed.expiresAt) &&
      parsed.expiresAt > Date.now()
    )
  } catch {
    return false
  }
}
