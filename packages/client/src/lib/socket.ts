import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@music-together/shared'
import { SERVER_URL } from './config'

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>

let socket: TypedSocket | null = null

export function getSocket(): TypedSocket {
  if (!socket) {
    socket = io(SERVER_URL, {
      autoConnect: false,
      withCredentials: true,
      // 轮询先行、再升级 WebSocket（socket.io 经典策略）。不要改成 ws 优先：
      // 存在「ws 能打开但随即被掐断」的网络环境（代理/VPN 等），此时
      // tryAllTransports 的打开期回退不会触发，ws 优先会导致无限重连；
      // 升级探测失败则会自动留在 polling 上，连接始终可用。
      transports: ['polling', 'websocket'],
      tryAllTransports: true,
    }) as TypedSocket
  }
  return socket
}

export function connectSocket(): TypedSocket {
  const s = getSocket()
  if (!s.connected) {
    s.connect()
  }
  return s
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}

/** Returns a promise that resolves when the socket is connected */
export function waitForConnect(): Promise<TypedSocket> {
  const s = getSocket()
  if (s.connected) return Promise.resolve(s)
  return new Promise((resolve) => {
    s.once('connect', () => resolve(s))
    if (!s.connected) s.connect()
  })
}
