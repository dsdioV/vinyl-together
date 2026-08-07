import type { Track } from '@music-together/shared'

/** 按标题或歌手本地过滤主队列（大小写不敏感；空查询返回原列表副本）。 */
export function filterQueueTracks(tracks: readonly Track[], query: string): Track[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...tracks]
  return tracks.filter(
    (track) => track.title.toLowerCase().includes(q) || track.artist.some((a) => a.toLowerCase().includes(q)),
  )
}
