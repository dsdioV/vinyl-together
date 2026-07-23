import { useSocketContext } from '@/providers/SocketProvider'
import { resetAllRoomState } from '@/lib/resetStores'
import { storage } from '@/lib/storage'
import { EVENTS } from '@music-together/shared'
import { useCallback } from 'react'
import { useRoomStore } from '@/stores/roomStore'

import { useRoomState } from './room/useRoomState'
import { useChatSync } from './room/useChatSync'
import { useQueueSync } from './room/useQueueSync'
import { useAuthSync } from './room/useAuthSync'
import { useConnectionGuard } from './room/useConnectionGuard'
import { abortActiveLocalAudioUpload, useLocalAudioSync, useLocalAudioUploadRunner } from './room/useLocalAudioSync'

/**
 * Composition hook that wires up all room-related socket event listeners.
 * Sub-hooks are split by responsibility for maintainability.
 * The public API (leaveRoom, updateSettings, setUserRole) remains unchanged.
 */
export function useRoom() {
  const { socket } = useSocketContext()

  // Sub-hooks handle their own event listeners
  useRoomState()
  useChatSync()
  useQueueSync()
  useAuthSync()
  useConnectionGuard()
  useLocalAudioSync()
  useLocalAudioUploadRunner()

  const leaveRoom = useCallback(() => {
    const roomId = useRoomStore.getState().room?.id
    // Abort only the active raw-file request. Tasks that have already been
    // fully received may still be transcoding on the server and intentionally
    // remain room-owned after this client leaves.
    abortActiveLocalAudioUpload(undefined, 'detach')
    if (roomId) storage.clearRejoinToken(roomId)
    socket.emit(EVENTS.ROOM_LEAVE)
    resetAllRoomState()
  }, [socket])

  const updateSettings = useCallback(
    (settings: {
      name?: string
      password?: string | null
      audioQuality?: import('@music-together/shared').AudioQuality
      autoRemovePlayed?: boolean
      songLikes?: boolean
      voteThreshold?: number
      maxQueueSize?: number
    }) => {
      socket.emit(EVENTS.ROOM_SETTINGS, settings)
    },
    [socket],
  )

  const setUserRole = useCallback(
    (userId: string, role: 'admin' | 'member') => {
      socket.emit(EVENTS.ROOM_SET_ROLE, { userId, role })
    },
    [socket],
  )

  return { leaveRoom, updateSettings, setUserRole }
}
