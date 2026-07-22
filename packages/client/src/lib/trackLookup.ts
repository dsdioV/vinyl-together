import type { Track } from '@music-together/shared'

export type TrackLookupResult = { ok: true; track: Track } | { ok: false; code: string; message: string }

interface ErrorPayload {
  code?: unknown
  error?: unknown
}

export function trackLookupFailure(status: number, payload: ErrorPayload | null): TrackLookupResult {
  const code = typeof payload?.code === 'string' ? payload.code : 'TRACK_LOOKUP_FAILED'
  if (typeof payload?.error === 'string' && payload.error.length <= 200) {
    return { ok: false, code, message: payload.error }
  }

  switch (status) {
    case 404:
      return { ok: false, code, message: '未找到该歌曲，请检查 ID 或链接是否正确' }
    case 429:
      return { ok: false, code, message: '酷狗暂时要求安全验证，请稍后重试' }
    case 502:
    case 504:
      return { ok: false, code, message: '酷狗服务暂时不可用，请稍后重试' }
    default:
      return { ok: false, code, message: '歌曲解析失败，请稍后重试' }
  }
}
