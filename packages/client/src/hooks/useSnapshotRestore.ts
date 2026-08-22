import { useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import { toast } from 'sonner'
import type { DefaultQueueTrackRef } from '@music-together/shared'
import { LIMITS } from '@music-together/shared'
import { restoreSnapshotToRoom, type RestoreResult } from '@/lib/defaultQueueArchive'

/**
 * 恢复存档到房间并驱动一个持续更新的 loading toast：
 * 「正在恢复 · 已发送 x/N 首」。结束后替换为成功/部分完成摘要。
 */
export function useSnapshotRestore() {
  return useCallback(
    async (
      socket: Socket,
      tracks: readonly DefaultQueueTrackRef[],
      currentRefs: readonly DefaultQueueTrackRef[],
    ): Promise<RestoreResult | null> => {
      if (tracks.length === 0) {
        toast.info('存档是空的，先在默认播放列表里保存一份')
        return null
      }
      const remainingCapacity = Math.max(0, LIMITS.DEFAULT_QUEUE_MAX_SIZE - currentRefs.length)
      if (remainingCapacity === 0) {
        toast.info('默认播放列表已满')
        return null
      }

      const toastId = toast.loading(`开始恢复默认歌单存档（共 ${tracks.length} 首）`)

      try {
        const result = await restoreSnapshotToRoom({
          socket,
          tracks,
          currentRefs,
          onProgress: (p) => toast.loading(`正在恢复默认歌单 · 已发送 ${p.sent}/${p.total} 首`, { id: toastId }),
        })

        if (result.queued === 0) {
          toast.info('存档歌曲都已在本房间的默认列表中，无需恢复', { id: toastId })
          return result
        }

        const parts = [`已恢复 ${result.queued} 首到默认播放列表`]
        if (result.skippedDuplicates > 0) parts.push(`跳过重复 ${result.skippedDuplicates} 首`)
        if (result.truncated > 0) parts.push(`${result.truncated} 首超出默认列表容量`)
        toast.success(parts.join('，'), { id: toastId })
        return result
      } catch (err) {
        toast.error(`恢复存档失败：${err instanceof Error ? err.message : String(err)}`, { id: toastId })
        return null
      }
    },
    [],
  )
}
