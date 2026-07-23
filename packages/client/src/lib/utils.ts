import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { QueueTrackInput, Track } from '@music-together/shared'
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
    lyricId: track.lyricId,
    picId: track.picId,
    vip: track.vip,
  }
}

/** Construct the source platform URL for a track */
export const getSourceUrl = (t: Pick<Track, 'source' | 'sourceId'>): string | null => {
  switch (t.source as string) {
    case 'netease':
      return `https://music.163.com/song?id=${t.sourceId}`
    case 'tencent':
      return `https://y.qq.com/n/ryqq/songDetail/${t.sourceId}`
    case 'kugou':
      return `https://www.kugou.com/song/#hash=${t.sourceId}`
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

/** Covers in authoritative local tracks are server-generated and may be relative. */
export function getTrackCoverUrl(track: Pick<Track, 'source' | 'cover'>): string | undefined {
  if (!track.cover) return undefined
  return track.source === 'local' ? resolveLocalAudioMediaUrl(track.cover) : track.cover
}
