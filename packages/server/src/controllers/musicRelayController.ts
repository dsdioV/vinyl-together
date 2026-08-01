import { EVENTS } from '@music-together/shared'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { musicRelayService } from '../services/musicRelayService.js'

export function registerMusicRelayController(io: TypedServer, socket: TypedSocket) {
  socket.on(EVENTS.RELAY_MODE_CHANGED, (data) => {
    musicRelayService.setRelayEnabled(socket.id, Boolean(data?.enabled))
  })

  socket.on(EVENTS.MUSIC_RELAY_RESPONSE, (data) => {
    musicRelayService.handleResponse(socket.id, data?.requestId, Boolean(data?.ok), data?.data)
  })

  socket.on('disconnect', () => {
    musicRelayService.handleDisconnect(socket.id)
  })
}
