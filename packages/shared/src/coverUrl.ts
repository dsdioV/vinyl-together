import type { MusicSource } from './types.js'

const TRACK_COVER_HOSTS: Readonly<Record<MusicSource, ReadonlySet<string>>> = {
  netease: new Set(['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net']),
  tencent: new Set(['y.gtimg.cn']),
  kugou: new Set(['imge.kugou.com', 'imgessl.kugou.com']),
  bilibili: new Set(['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com']),
}

const ALL_TRACK_COVER_HOSTS = new Set(Object.values(TRACK_COVER_HOSTS).flatMap((hosts) => Array.from(hosts)))

function sanitizeCoverUrl(raw: string, allowedHosts: ReadonlySet<string>): string {
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.username || parsed.password || parsed.port) return ''
    if (!allowedHosts.has(parsed.hostname)) return ''

    // Known cover CDNs all support HTTPS. Avoid making room members load
    // clear-text images even when an upstream API returns an old HTTP URL.
    parsed.protocol = 'https:'
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

/**
 * Normalize a client-supplied Track cover URL and bind it to the declared
 * music source. Invalid or untrusted URLs degrade to an empty cover.
 */
export function sanitizeTrackCoverUrl(raw: string, source: MusicSource): string {
  return sanitizeCoverUrl(raw, TRACK_COVER_HOSTS[source])
}

/** Normalize a URL accepted by the public cover proxy. */
export function sanitizeCoverProxyUrl(raw: string): string {
  return sanitizeCoverUrl(raw, ALL_TRACK_COVER_HOSTS)
}
