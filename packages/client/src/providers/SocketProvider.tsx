import { getSocket, type TypedSocket } from '@/lib/socket'
import { SERVER_URL } from '@/lib/config'
import { storage } from '@/lib/storage'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

interface SocketContextValue {
  socket: TypedSocket
  isConnected: boolean
  connectionState: ConnectionState
}

const SocketContext = createContext<SocketContextValue | null>(null)

/** Persistent toast id so we can dismiss it on reconnect */
const DISCONNECT_TOAST_ID = 'socket-disconnect'
const CONNECT_WATCHDOG_TOAST_ID = 'socket-connect-watchdog'

/**
 * 连接看门狗间隔。engine.io 的 WebSocket 握手若在网络层静默挂起（不成功也不报错），
 * 既不会触发 connect 也不会触发 connect_error，manager 因此永远不会自动重试，
 * 页面会停在「加载中」直到用户手动刷新——所以必须由外部周期性强制重试。
 */
const CONNECT_WATCHDOG_MS = 10_000

/** 身份引导请求超时，避免个别网络下 fetch 长时间悬挂阻塞整个连接流程 */
const BOOTSTRAP_TIMEOUT_MS = 8_000

export function SocketProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<TypedSocket>(getSocket())
  const hasDisconnectedRef = useRef(false)
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    socketRef.current.connected ? 'connected' : 'connecting',
  )
  const isConnected = connectionState === 'connected'

  useEffect(() => {
    const socket = socketRef.current
    let cancelled = false
    let reauthenticating = false
    let watchdog: ReturnType<typeof setInterval> | null = null

    const stopWatchdog = () => {
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
    }

    const onConnect = () => {
      stopWatchdog()
      setConnectionState('connected')
      toast.dismiss(CONNECT_WATCHDOG_TOAST_ID)
      toast.dismiss(DISCONNECT_TOAST_ID)
      if (hasDisconnectedRef.current) {
        toast.success('已重新连接', { id: 'socket-reconnect' })
      }
    }

    const onDisconnect = () => {
      setConnectionState('disconnected')
      hasDisconnectedRef.current = true
      toast.warning('连接已断开，正在重连…', {
        id: DISCONNECT_TOAST_ID,
        duration: Infinity,
      })
    }

    const bootstrapIdentity = async (showError = true): Promise<boolean> => {
      try {
        const res = await fetch(`${SERVER_URL}/api/auth/identity/bootstrap`, {
          method: 'POST',
          credentials: 'include',
          signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
        })
        if (!res.ok) {
          storage.clearUserId()
          if (showError) toast.error('身份初始化失败，请刷新重试')
          return false
        }

        const userId = res.headers.get('X-Identity-UserId') ?? res.headers.get('x-identity-userid')
        if (userId && userId.trim().length > 0) {
          storage.setUserId(userId.trim())
        } else {
          storage.clearUserId()
        }
        return true
      } catch {
        storage.clearUserId()
        if (showError) toast.error('连接服务器失败，请稍后重试')
        return false
      }
    }

    const ensureIdentityAndConnect = async (showError = true): Promise<void> => {
      const ok = await bootstrapIdentity(showError)
      if (ok && !cancelled && !socket.connected) {
        startWatchdog()
        socket.connect()
      }
    }

    const onConnectError = async (err: Error) => {
      if (err.message !== 'UNAUTHENTICATED') return
      if (cancelled || reauthenticating) return

      reauthenticating = true
      try {
        const ok = await bootstrapIdentity(false)
        if (ok && !cancelled && !socket.connected) {
          startWatchdog()
          socket.connect()
        }
      } finally {
        reauthenticating = false
      }
    }

    /**
     * 周期检查：未连接时强制断开并重试。manager 自带的重连只覆盖「报错」的失败，
     * 静默挂起的握手需要这里兜底；对处于退避等待中的 manager 提前发起重试无害。
     */
    function startWatchdog() {
      stopWatchdog()
      watchdog = setInterval(() => {
        if (cancelled || socket.connected) return
        socket.disconnect()
        socket.connect()
        if (!hasDisconnectedRef.current) {
          toast.warning('连接服务器超时，正在重试…', {
            id: CONNECT_WATCHDOG_TOAST_ID,
            duration: 5_000,
          })
        }
      }, CONNECT_WATCHDOG_MS)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    ensureIdentityAndConnect()

    return () => {
      cancelled = true
      stopWatchdog()
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
    }
  }, [])

  const value = useMemo<SocketContextValue>(
    () => ({ socket: socketRef.current, isConnected, connectionState }),
    [isConnected, connectionState],
  )

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
}

export function useSocketContext(): SocketContextValue {
  const ctx = useContext(SocketContext)
  if (!ctx) throw new Error('useSocketContext must be used within SocketProvider')
  return ctx
}
