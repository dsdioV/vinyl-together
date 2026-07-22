import type { MusicSource } from '@music-together/shared'

const OFFICIAL_HOSTS: Record<MusicSource, ReadonlySet<string>> = {
  netease: new Set(['music.163.com']),
  tencent: new Set(['y.qq.com']),
  kugou: new Set(['www.kugou.com']),
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

  if (!['http:', 'https:'].includes(url.protocol) || !OFFICIAL_HOSTS[source].has(url.hostname)) {
    return null
  }

  switch (source) {
    case 'netease':
      return parseNeteaseUrl(url)
    case 'tencent':
      return parseTencentUrl(url)
    case 'kugou':
      return parseKugouUrl(url)
  }
}
