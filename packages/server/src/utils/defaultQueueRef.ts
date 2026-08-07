import type { DefaultQueueTrackRef, Track } from '@music-together/shared'
import * as authService from '../services/authService.js'
import { localAudioService } from '../services/localAudioService.js'
import { musicProvider } from '../services/musicProvider.js'

/** 将完整 Track 收窄为默认播放列表的轻量引用（只保留展示/搜索/标识所需字段）。 */
export function toDefaultQueueRef(track: Track): DefaultQueueTrackRef {
  return {
    id: track.id,
    source: track.source,
    sourceId: track.sourceId,
    title: track.title,
    artist: track.artist,
    ...(track.assetId ? { assetId: track.assetId } : {}),
  }
}

/**
 * 将轻量引用补全为完整 Track（本地资产直接取内存元数据，在线音源先查注册表再回落平台 API）。
 * 补全失败（平台下架 / 本地资产消失）返回 null。
 * 返回的 Track 保留引用的稳定 id，供客户端映射与移除。
 */
export async function resolveDefaultQueueRef(roomId: string, ref: DefaultQueueTrackRef): Promise<Track | null> {
  if (ref.source === 'local') {
    if (!ref.assetId) return null
    const track = localAudioService.buildTrack(roomId, ref.assetId)
    if (!track) return null
    return { ...track, id: ref.id }
  }

  const cookie = authService.getAnyCookie(ref.source, roomId)
  const track = await musicProvider.getTrackById(ref.source, ref.sourceId, cookie ?? undefined)
  if (!track) return null
  return { ...track, id: ref.id }
}

/** 并发受限的批量补全（默认 chunk 并发 5），返回完整 Track 与缺失 ID 列表。 */
export async function resolveDefaultQueueRefs(
  roomId: string,
  refs: DefaultQueueTrackRef[],
  concurrency = 5,
): Promise<{ tracks: Track[]; missingIds: string[] }> {
  const tracks: Track[] = []
  const missingIds: string[] = []
  for (let i = 0; i < refs.length; i += concurrency) {
    const chunk = refs.slice(i, i + concurrency)
    const results = await Promise.all(chunk.map((ref) => resolveDefaultQueueRef(roomId, ref)))
    for (let j = 0; j < chunk.length; j++) {
      const track = results[j]
      if (track) tracks.push(track)
      else missingIds.push(chunk[j]!.id)
    }
  }
  return { tracks, missingIds }
}
