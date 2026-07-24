import { useCallback } from 'react'
import { toast } from 'sonner'
import { useRoomStore } from '@/stores/roomStore'
import { useLocalAudioStore } from '@/stores/localAudioStore'
import { formatLocalAudioBytes, selectLocalAudioFiles, type LocalAudioFileRejection } from '@/lib/localAudioFiles'

export interface LocalAudioEnqueueResult {
  hasFiles: boolean
  canUpload: boolean
  acceptedCount: number
  rejected: LocalAudioFileRejection[]
  taskIds: string[]
}

const EMPTY_RESULT: LocalAudioEnqueueResult = {
  hasFiles: false,
  canUpload: false,
  acceptedCount: 0,
  rejected: [],
  taskIds: [],
}

/** Shared admission path for file-picker and drag-and-drop uploads. */
export function useLocalAudioFileQueue(): (files: Iterable<File>) => LocalAudioEnqueueResult {
  const currentUser = useRoomStore((state) => state.currentUser)
  const maxUploadBytes = useLocalAudioStore((state) => state.usage?.maxUploadBytes)
  const addToQueue = useLocalAudioStore((state) => state.addToQueueAfterUpload)
  const enqueueFiles = useLocalAudioStore((state) => state.enqueueFiles)

  return useCallback(
    (files: Iterable<File>) => {
      const input = Array.from(files)
      if (!currentUser || input.length === 0) {
        return { ...EMPTY_RESULT, hasFiles: input.length > 0, canUpload: Boolean(currentUser) }
      }

      const selection = selectLocalAudioFiles(input, maxUploadBytes)
      for (const rejection of selection.rejected) {
        if (rejection.reason === 'size' && maxUploadBytes !== undefined) {
          toast.error(`「${rejection.file.name}」超过 ${formatLocalAudioBytes(maxUploadBytes)} 上限`)
        } else {
          toast.error(`「${rejection.file.name}」格式不受支持`)
        }
      }

      const taskIds =
        selection.accepted.length > 0
          ? enqueueFiles(selection.accepted, {
              ownerId: currentUser.id,
              ownerNickname: currentUser.nickname,
              addToQueue,
            })
          : []
      if (taskIds.length > 0) toast.success(`已加入 ${taskIds.length} 个上传任务`)

      return {
        hasFiles: true,
        canUpload: true,
        acceptedCount: selection.accepted.length,
        rejected: selection.rejected,
        taskIds,
      }
    },
    [addToQueue, currentUser, enqueueFiles, maxUploadBytes],
  )
}
