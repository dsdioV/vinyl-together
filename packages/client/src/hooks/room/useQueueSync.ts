import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { EVENTS } from '@music-together/shared'
import type { DefaultQueueDelta, DefaultQueueTrackRef, PlayedTrack, QueueDelta, Track } from '@music-together/shared'
import { useEffect } from 'react'

/** Keeps the local queue in sync with server-side QUEUE_UPDATED events. */
export function useQueueSync() {
  const { socket } = useSocketContext()

  useEffect(() => {
    const onQueueUpdated = (delta: QueueDelta) => {
      const room = useRoomStore.getState().room
      if (!room) return
      const queue = [...room.queue]
      switch (delta.type) {
        case 'clear':
          useRoomStore.getState().updateRoom({ queue: [] })
          break
        case 'insert':
          queue.splice(delta.atIndex, 0, ...delta.tracks)
          useRoomStore.getState().updateRoom({ queue })
          break
        case 'remove': {
          const removeSet = new Set(delta.trackIds)
          useRoomStore.getState().updateRoom({ queue: queue.filter((t) => !removeSet.has(t.id)) })
          break
        }
        case 'replace':
          if (delta.atIndex >= 0 && delta.atIndex < queue.length) {
            queue[delta.atIndex] = delta.track
            useRoomStore.getState().updateRoom({ queue })
          }
          break
        case 'reorder': {
          const trackMap = new Map(queue.map((t) => [t.id, t]))
          const reordered = delta.trackIds.map((id) => trackMap.get(id)).filter((t): t is Track => t !== undefined)
          useRoomStore.getState().updateRoom({ queue: reordered })
          break
        }
      }
    }

    const onDefaultQueueUpdated = (data: { defaultQueue: DefaultQueueTrackRef[] }) => {
      const room = useRoomStore.getState().room
      if (room) {
        useRoomStore.getState().updateRoom({ defaultQueue: data.defaultQueue })
      }
    }

    const onDefaultQueueDelta = (delta: DefaultQueueDelta) => {
      const room = useRoomStore.getState().room
      if (!room) return
      let defaultQueue = [...room.defaultQueue]
      switch (delta.type) {
        case 'add': {
          const existing = new Set(defaultQueue.map((t) => t.id))
          defaultQueue.push(...delta.tracks.filter((t) => !existing.has(t.id)))
          useRoomStore.getState().updateRoom({ defaultQueue })
          break
        }
        case 'remove': {
          const removeSet = new Set(delta.trackIds)
          useRoomStore.getState().updateRoom({ defaultQueue: defaultQueue.filter((t) => !removeSet.has(t.id)) })
          break
        }
        case 'replace':
          useRoomStore.getState().updateRoom({
            defaultQueue: defaultQueue.map((t) => (t.id === delta.track.id ? delta.track : t)),
          })
          break
        case 'clear':
          useRoomStore.getState().updateRoom({ defaultQueue: [] })
          break
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
    socket.on(EVENTS.DEFAULT_QUEUE_DELTA, onDefaultQueueDelta)
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
      socket.off(EVENTS.DEFAULT_QUEUE_DELTA, onDefaultQueueDelta)
      socket.off(EVENTS.QUEUE_LIKES_UPDATED, onLikesUpdated)
      socket.off(EVENTS.PLAYED_HISTORY_UPDATED, onPlayedHistoryUpdated)
    }
  }, [socket])
}
