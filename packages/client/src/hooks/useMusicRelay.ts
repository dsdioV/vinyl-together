import { EVENTS } from '@music-together/shared'
import { useEffect } from 'react'
import { useSocketContext } from '@/providers/SocketProvider'
import { storage } from '@/lib/storage'

const RELAY_URL_PREFIX = 'https://u.y.qq.com/cgi-bin/musicu.fcg?'
const RELAY_TIMEOUT_MS = 10_000

/** 通过 <script> 标签执行一次 JSONP 请求（跨域读取响应，不受 CORS 限制）。 */
function jsonpRequest(url: string, callbackName: string, timeoutMs = RELAY_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const windowAny = window as unknown as Record<string, unknown>
    let done = false
    const script = document.createElement('script')

    const cleanup = () => {
      delete windowAny[callbackName]
      script.remove()
      clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('中继请求超时'))
    }, timeoutMs)

    windowAny[callbackName] = (data: unknown) => {
      if (done) return
      done = true
      cleanup()
      resolve(data)
    }

    script.src = url
    script.async = true
    script.onerror = () => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('中继请求加载失败'))
    }
    document.body.appendChild(script)
  })
}

/**
 * QQ 音乐浏览器中继：监听服务端的中继请求，用本浏览器代为执行 JSONP 请求。
 * 仅处理白名单内的 QQ 播放链接接口；响应回传后由服务端校验，本端不缓存数据。
 */
export function useMusicRelay() {
  const { socket } = useSocketContext()

  useEffect(() => {
    const syncRelayMode = () => {
      socket.emit(EVENTS.RELAY_MODE_CHANGED, { enabled: storage.getQqRelayEnabled() })
    }

    const onRelayRequest = async (req: { requestId: string; url: string }) => {
      try {
        if (!req?.requestId || typeof req.url !== 'string' || !req.url.startsWith(RELAY_URL_PREFIX)) {
          socket.emit(EVENTS.MUSIC_RELAY_RESPONSE, { requestId: req.requestId, ok: false, error: 'invalid request' })
          return
        }
        const callback = new URL(req.url, window.location.origin).searchParams.get('callback') ?? ''
        if (!/^[A-Za-z0-9_]+$/.test(callback)) {
          socket.emit(EVENTS.MUSIC_RELAY_RESPONSE, { requestId: req.requestId, ok: false, error: 'invalid callback' })
          return
        }
        const data = await jsonpRequest(req.url, callback)
        socket.emit(EVENTS.MUSIC_RELAY_RESPONSE, { requestId: req.requestId, ok: true, data })
      } catch (err) {
        socket.emit(EVENTS.MUSIC_RELAY_RESPONSE, {
          requestId: req.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    socket.on(EVENTS.MUSIC_RELAY_REQUEST, onRelayRequest)
    socket.on('connect', syncRelayMode)
    // 进入房间时同步一次当前开关状态
    syncRelayMode()
    return () => {
      socket.off(EVENTS.MUSIC_RELAY_REQUEST, onRelayRequest)
      socket.off('connect', syncRelayMode)
    }
  }, [socket])
}
