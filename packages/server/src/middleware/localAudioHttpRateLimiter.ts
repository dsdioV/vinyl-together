import { RateLimiterMemory } from 'rate-limiter-flexible'

export const LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE = '操作过于频繁，请稍后再试'

export const LOCAL_AUDIO_HTTP_RATE_LIMITS = {
  mutation: {
    points: 30,
    durationSeconds: 10,
  },
  snapshot: {
    points: 120,
    durationSeconds: 10,
  },
} as const

export type LocalAudioHttpRateLimitKind = keyof typeof LOCAL_AUDIO_HTTP_RATE_LIMITS

const mutationLimiter = new RateLimiterMemory({
  points: LOCAL_AUDIO_HTTP_RATE_LIMITS.mutation.points,
  duration: LOCAL_AUDIO_HTTP_RATE_LIMITS.mutation.durationSeconds,
})

const snapshotLimiter = new RateLimiterMemory({
  points: LOCAL_AUDIO_HTTP_RATE_LIMITS.snapshot.points,
  duration: LOCAL_AUDIO_HTTP_RATE_LIMITS.snapshot.durationSeconds,
})

/**
 * Consume a user-scoped HTTP control-plane limit. Callers must authenticate
 * and verify room membership before reaching this function so anonymous or
 * unauthorized traffic cannot consume another member's bucket.
 */
export async function checkLocalAudioHttpRateLimit(
  userId: string,
  kind: LocalAudioHttpRateLimitKind,
): Promise<boolean> {
  const limiter = kind === 'snapshot' ? snapshotLimiter : mutationLimiter
  try {
    await limiter.consume(userId)
    return true
  } catch {
    return false
  }
}
