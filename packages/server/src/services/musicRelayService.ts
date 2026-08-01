import { EVENTS } from '@music-together/shared'
import { nanoid } from 'nanoid'
import type { TypedServer } from '../middleware/types.js'
import { logger } from '../utils/logger.js'

/** 单个中继请求的最长等待时间（毫秒） */
const RELAY_TIMEOUT_MS = 10_000
/** 一次解析最多询问几个已开启中继的客户端 */
const MAX_RELAY_CLIENTS = 3
/** 中继请求 URL 白名单前缀（服务端只构造此接口的 JSONP 请求） */
const RELAY_URL_PREFIX = 'https://u.y.qq.com/cgi-bin/musicu.fcg?'

interface PendingRelay {
  socketId: string
  requestId: string
  timer: NodeJS.Timeout
  resolve: (value: { ok: boolean; data?: unknown } | null) => void
}

/**
 * QQ 音乐浏览器中继服务。
 *
 * 服务器直连 QQ 音乐失败（如服务器 IP 位于海外）时，可让已开启中继的
 * 房间成员浏览器代为发起 JSONP 请求。服务端只向白名单内的固定 QQ 接口
 * 发起中继，响应数据原样回传后由调用方校验。
 */
class MusicRelayService {
  private io: TypedServer | null = null
  /** socketId -> 该客户端是否已开启中继 */
  private enabled = new Set<string>()
  /** requestId -> 等待中的请求 */
  private pending = new Map<string, PendingRelay>()

  setIo(io: TypedServer): void {
    this.io = io
  }

  /** 清空运行时状态（用于测试或服务重启时的兜底清理）。 */
  reset(): void {
    this.enabled.clear()
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
  }

  setRelayEnabled(socketId: string, enabled: boolean): void {
    if (enabled) {
      this.enabled.add(socketId)
    } else {
      this.enabled.delete(socketId)
    }
    logger.info(`QQ relay mode for socket ${socketId}: ${enabled ? 'on' : 'off'}`)
  }

  handleDisconnect(socketId: string): void {
    this.enabled.delete(socketId)
    for (const [requestId, pending] of this.pending) {
      if (pending.socketId !== socketId) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve(null)
    }
  }

  handleResponse(socketId: string, requestId: string, ok: boolean, data?: unknown): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.socketId !== socketId) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve({ ok, data })
  }

  /**
   * 请求已开启中继的客户端代为发起 JSONP 请求。
   * 依次尝试最多 MAX_RELAY_CLIENTS 个空闲客户端，返回第一个成功回传的 JSON 数据；
   * 全部失败或超时返回 null。
   */
  async requestJson(url: string): Promise<unknown | null> {
    if (!this.io) return null
    if (!url.startsWith(RELAY_URL_PREFIX)) {
      logger.warn('QQ relay rejected non-whitelisted URL')
      return null
    }

    let tried = 0
    // 每次调用中每个客户端只尝试一次，避免超时后无限重试
    const attempted = new Set<string>()
    for (const socketId of [...this.enabled]) {
      if (attempted.has(socketId)) continue
      if (tried >= MAX_RELAY_CLIENTS) break
      // 同一客户端同一时间只处理一个请求
      const busy = [...this.pending.values()].some((p) => p.socketId === socketId)
      if (busy) continue

      attempted.add(socketId)
      tried++
      const requestId = nanoid(12)
      const result = await this.requestOnce(socketId, requestId, url)
      if (result?.ok && result.data !== undefined) {
        return result.data
      }
    }
    return null
  }

  private requestOnce(
    socketId: string,
    requestId: string,
    url: string,
  ): Promise<{ ok: boolean; data?: unknown } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        logger.warn(`QQ relay request timed out: ${requestId} -> ${socketId}`)
        resolve(null)
      }, RELAY_TIMEOUT_MS)
      this.pending.set(requestId, { socketId, requestId, timer, resolve })
      this.io!.to(socketId).emit(EVENTS.MUSIC_RELAY_REQUEST, { requestId, url })
    })
  }
}

export const musicRelayService = new MusicRelayService()
