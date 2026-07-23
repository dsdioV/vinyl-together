import { useSocketContext } from '@/providers/SocketProvider'
import { resetAllRoomState } from '@/lib/resetStores'
import { abortActiveLocalAudioUpload } from './useLocalAudioSync'
import { useEffect } from 'react'

/**
 * Resets all room-related stores on socket disconnect.
 * Re-join on reconnect is handled by RoomPage's auto-join effect.
 */
export function useConnectionGuard() {
  const { socket } = useSocketContext()

  useEffect(() => {
    const onDisconnect = () => {
      abortActiveLocalAudioUpload(undefined, 'detach')
      resetAllRoomState()
    }

    socket.on('disconnect', onDisconnect)

    return () => {
      socket.off('disconnect', onDisconnect)
    }
  }, [socket])
}
