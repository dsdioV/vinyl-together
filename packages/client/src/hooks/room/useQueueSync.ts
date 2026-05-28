import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { EVENTS } from '@music-together/shared'
import type { PlayedTrack, Track } from '@music-together/shared'
import { useEffect } from 'react'

/** Keeps the local queue in sync with server-side QUEUE_UPDATED events. */
export function useQueueSync() {
  const { socket } = useSocketContext()

  useEffect(() => {
    const onQueueUpdated = (data: { queue: Track[] }) => {
      const room = useRoomStore.getState().room
      if (room) {
        useRoomStore.getState().updateRoom({ queue: data.queue })
      }
    }

    const onDefaultQueueUpdated = (data: { defaultQueue: Track[] }) => {
      const room = useRoomStore.getState().room
      if (room) {
        useRoomStore.getState().updateRoom({ defaultQueue: data.defaultQueue })
      }
    }

    const onLikesUpdated = (data: { trackLikes: Record<string, string[]> }) => {
      const room = useRoomStore.getState().room
      if (room) {
        useRoomStore.getState().updateRoom({ trackLikes: data.trackLikes })
      }
    }

    socket.on(EVENTS.QUEUE_UPDATED, onQueueUpdated)
    socket.on(EVENTS.DEFAULT_QUEUE_UPDATED, onDefaultQueueUpdated)
    const onPlayedHistoryUpdated = (data: { playedHistory: PlayedTrack[] }) => {
      const room = useRoomStore.getState().room
      if (room) {
        useRoomStore.getState().updateRoom({ playedHistory: data.playedHistory })
      }
    }

    socket.on(EVENTS.QUEUE_LIKES_UPDATED, onLikesUpdated)
    socket.on(EVENTS.PLAYED_HISTORY_UPDATED, onPlayedHistoryUpdated)

    return () => {
      socket.off(EVENTS.QUEUE_UPDATED, onQueueUpdated)
      socket.off(EVENTS.DEFAULT_QUEUE_UPDATED, onDefaultQueueUpdated)
      socket.off(EVENTS.QUEUE_LIKES_UPDATED, onLikesUpdated)
      socket.off(EVENTS.PLAYED_HISTORY_UPDATED, onPlayedHistoryUpdated)
    }
  }, [socket])
}
