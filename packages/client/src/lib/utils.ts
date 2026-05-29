import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Track } from '@music-together/shared'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Stable unique key for a track based on source + sourceId */
export const trackKey = (t: Pick<Track, 'source' | 'sourceId'>): string => `${t.source}:${t.sourceId}`

/** Construct the source platform URL for a track */
export const getSourceUrl = (t: Pick<Track, 'source' | 'sourceId'>): string => {
  switch (t.source) {
    case 'netease':
      return `https://music.163.com/song?id=${t.sourceId}`
    case 'tencent':
      return `https://y.qq.com/n/ryqq/songDetail/${t.sourceId}`
    case 'kugou':
      return `https://www.kugou.com/song/#hash=${t.sourceId}`
    default:
      return '#'
  }
}
