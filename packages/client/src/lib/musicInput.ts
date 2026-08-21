import type { MusicSource } from '@music-together/shared'

const OFFICIAL_HOSTS: Record<MusicSource, ReadonlySet<string>> = {
  netease: new Set(['music.163.com']),
  tencent: new Set(['y.qq.com']),
  kugou: new Set(['www.kugou.com']),
  bilibili: new Set(['www.bilibili.com']),
  bandcamp: new Set([]),
}

function parseNeteaseUrl(url: URL): string | null {
  // Keep all official query-based song/album/playlist links compatible.
  const id = url.searchParams.get('id')
  if (id && /^\d+$/.test(id)) return id

  const hashMatch = url.hash.match(/[?&]id=(\d+)(?:&|$)/)
  if (hashMatch) return hashMatch[1]

  return url.pathname.match(/^\/(?:song|album|playlist)\/(\d+)(?:\.html)?\/?$/)?.[1] ?? null
}

function parseTencentUrl(url: URL): string | null {
  return url.pathname.match(/^\/n\/ryqq\/playlist\/(\d+)(?:\.html)?\/?$/)?.[1] ?? null
}

function parseKugouUrl(url: URL): string | null {
  if (/^\/song\/?$/.test(url.pathname) && url.hash) {
    const fragment = url.hash.slice(1).split(/[?&]/, 1)[0].trim()
    const hashMatch = fragment.match(/^hash=([a-f\d]{32})$/i)
    if (hashMatch) return hashMatch[1]
    if (/^(?=.{6,14}$)(?=.*[a-z])[a-z\d]+$/i.test(fragment)) return fragment
    return null
  }

  const songlistMatch = url.pathname.match(/^\/songlist\/([a-z\d_-]+)\/?$/i)
  if (songlistMatch) return songlistMatch[1]

  return url.pathname.match(/^\/yy\/special\/(?:single\/)?(\d+)(?:\.html)?\/?$/)?.[1] ?? null
}

function parseBilibiliUrl(url: URL): string | null {
  const videoMatch = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i)
  if (videoMatch) return videoMatch[1]
  return null
}

/**
 * bandcamp 每个艺人一个子域（artist.bandcamp.com），无法枚举精确主机名。
 * 返回规范化页面 URL（去 query/hash），服务端以 URL 形态抓取 tralbum 数据。
 */
function parseBandcampUrl(url: URL): string | null {
  const match = url.pathname.match(/^\/(track|album)\/([A-Za-z0-9._-]+)\/?$/)
  if (!match) return null
  return `https://${url.hostname}${match[0].replace(/\/$/, '')}`
}

/** bandcamp 域名按后缀匹配（艺人子域名不固定）。 */
function isOfficialHost(source: MusicSource, hostname: string): boolean {
  if (source === 'bandcamp') {
    return hostname === 'bandcamp.com' || hostname.endsWith('.bandcamp.com')
  }
  return OFFICIAL_HOSTS[source].has(hostname)
}

/** Extract a platform resource ID from a supported official URL or a plain ID. */
export function parsePlaylistInput(input: string, source: MusicSource): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Raw platform IDs remain intentionally permissive for backwards compatibility.
  if (/^[\w-]+$/.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (!['http:', 'https:'].includes(url.protocol) || !isOfficialHost(source, url.hostname)) {
    return null
  }

  switch (source) {
    case 'netease':
      return parseNeteaseUrl(url)
    case 'tencent':
      return parseTencentUrl(url)
    case 'kugou':
      return parseKugouUrl(url)
    case 'bilibili':
      return parseBilibiliUrl(url)
    case 'bandcamp':
      return parseBandcampUrl(url)
  }
}
