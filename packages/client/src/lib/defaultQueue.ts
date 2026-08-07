import { SERVER_URL } from '@/lib/config'
import type { Track } from '@music-together/shared'

export interface DefaultQueueTracksResult {
  tracks: Track[]
  missingIds: string[]
}

/** 批量补全默认播放列表元数据（仅 owner/admin 可调用）。单批最多 50 个 id。 */
export async function fetchDefaultQueueTracks(roomId: string, ids: string[]): Promise<DefaultQueueTracksResult> {
  if (ids.length === 0) return { tracks: [], missingIds: [] }
  const unique = [...new Set(ids)].slice(0, 50)
  const params = new URLSearchParams({ roomId, ids: unique.join(',') })
  const res = await fetch(`${SERVER_URL}/api/music/default-queue/tracks?${params.toString()}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch default queue tracks: ${res.status}`)
  }
  return (await res.json()) as DefaultQueueTracksResult
}
