import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { buildProxiedCoverUrl, type QueueTrackInput, type Track } from '@music-together/shared'
import { SERVER_URL } from '@/lib/config'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Stable unique key for a track based on source + sourceId */
export const trackKey = (t: Pick<Track, 'source' | 'sourceId'>): string => `${t.source}:${t.sourceId}`

/**
 * Convert an authoritative Track DTO into the restricted client queue input.
 * Local tracks must be represented by an asset reference; online stream URLs
 * are intentionally dropped so clients cannot submit server-generated URLs.
 */
export function toQueueTrackInput(track: Track): QueueTrackInput {
  if (track.source === 'local') {
    if (!track.assetId) throw new Error('本地歌曲缺少资产标识')
    return { source: 'local', assetId: track.assetId }
  }

  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    cover: track.cover,
    source: track.source,
    sourceId: track.sourceId,
    urlId: track.urlId,
    bilibiliCid: track.bilibiliCid,
    lyricId: track.lyricId,
    picId: track.picId,
    vip: track.vip,
  }
}

/** Construct the source platform URL for a track */
export const getSourceUrl = (t: Pick<Track, 'source' | 'sourceId' | 'urlId'>): string | null => {
  switch (t.source as string) {
    case 'netease':
      return `https://music.163.com/song?id=${t.sourceId}`
    case 'tencent':
      return `https://y.qq.com/n/ryqq/songDetail/${t.sourceId}`
    case 'kugou':
      return `https://www.kugou.com/song/#hash=${t.sourceId}`
    case 'bilibili':
      return `https://www.bilibili.com/video/${t.sourceId}`
    case 'bandcamp':
      // bandcamp 的站外链接是曲目页 URL（urlId），数字 sourceId 无法构造链接
      return /^https:\/\/[A-Za-z0-9-]+\.bandcamp\.com\//.test(t.urlId) ? t.urlId : null
    case 'local':
      return null
    default:
      return null
  }
}

/** Resolve server-generated local media paths when the API has another origin. */
export function resolveLocalAudioMediaUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, SERVER_URL).toString()
  } catch {
    return value
  }
}

/**
 * Resolve a track's cover URL for browser display.
 *
 * Third-party cover CDNs are fetched through the server's `/api/music/cover-proxy`
 * so the image loads from **our own origin**. Two reasons:
 *
 * 1. Firefox 的「增强型跟踪保护」(ETP) 会把第三方 CDN 当跟踪器拦截，导致封面空白；
 *    同源请求不受影响。
 * 2. bilibili 封面 CDN 有防盗链（浏览器直连会因非 bilibili Referer 返回 403）。
 *
 * 托管权与内容类型/大小限制由服务端代理集中校验（`sanitizeCoverProxyUrl` /
 * `readCoverResponse`）；URL 拼装逻辑在 `@music-together/shared` 内并被单测覆盖。
 */
export function getTrackCoverUrl(track: Pick<Track, 'source' | 'cover'>): string | undefined {
  if (!track.cover) return undefined
  // Local（以及任何服务端生成的相对路径）已由服务端签名分发，同源，无需代理。
  if (track.source === 'local') return resolveLocalAudioMediaUrl(track.cover)
  return buildProxiedCoverUrl(track.cover, SERVER_URL)
}
