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
  /** 请求被发往的 socket */
  socketId: string
  /** 该 socket 的稳定身份（`identityUserId`）。断线重连会换 socketId，但身份不变。 */
  ownerKey: string
  requestId: string
  timer: NodeJS.Timeout
  resolve: (value: { ok: boolean; data?: unknown; error?: string } | null) => void
}

/**
 * QQ 音乐浏览器中继服务。
 *
 * 服务器直连 QQ 音乐失败（如服务器 IP 位于海外）时，可让已开启中继的
 * 房间成员浏览器代为发起 JSONP 请求。服务端只向白名单内的固定 QQ 接口
 * 发起中继，响应数据原样回传后由调用方校验。
 *
 * 关联键是**稳定身份**而非 socketId：成员 socket 一旦重连（页面刷新、扩展导致
 * 的传输错误等）就会换 socketId，若按 socketId 严格匹配，重连前发出的请求其
 * 响应会被静默丢弃——表现为「既没有成功日志也没有超时日志」的无声失败。
 */
class MusicRelayService {
  private io: TypedServer | null = null
  /** socketId -> 该客户端是否已开启中继 */
  private enabled = new Set<string>()
  /** socketId -> 稳定身份（`identityUserId`），用于跨重连关联请求 */
  private owners = new Map<string, string>()
  /** requestId -> 等待中的请求 */
  private pending = new Map<string, PendingRelay>()

  setIo(io: TypedServer): void {
    this.io = io
  }

  /** 清空运行时状态（用于测试或服务重启时的兜底清理）。 */
  reset(): void {
    this.enabled.clear()
    this.owners.clear()
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
  }

  setRelayEnabled(socketId: string, enabled: boolean, ownerKey = ''): void {
    if (enabled) {
      this.enabled.add(socketId)
      if (ownerKey) this.owners.set(socketId, ownerKey)
    } else {
      this.enabled.delete(socketId)
      this.owners.delete(socketId)
    }
    logger.info(`QQ relay mode for socket ${socketId}: ${enabled ? 'on' : 'off'}`)
  }

  handleDisconnect(socketId: string): void {
    this.enabled.delete(socketId)
    this.owners.delete(socketId)

    // 不在这里丢弃 pending 请求：重连发生在断线**之后**，此刻新 socket 尚不存在，
    // 立即 resolve(null) 会让「重连后回传的响应」永远没有机会被采纳——这正是
    // 生产上「既无成功日志也无超时日志」的无声失败成因。改由请求自身的
    // RELAY_TIMEOUT_MS 兜底；同身份的响应（含重连后的新 socketId）仍会被采纳。
    let kept = 0
    for (const pending of this.pending.values()) {
      if (pending.socketId === socketId) kept++
    }
    if (kept > 0) {
      logger.info(`QQ relay client ${socketId} disconnected — ${kept} pending request(s) kept for possible reconnect`)
    }
  }

  handleResponse(socketId: string, requestId: string, ok: boolean, data?: unknown, error?: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      logger.warn(`QQ relay response ignored: unknown or already settled request ${requestId} from ${socketId}`)
      return
    }
    const callerOwner = this.owners.get(socketId) ?? ''
    const sameSocket = pending.socketId === socketId
    const sameOwner = pending.ownerKey !== '' && callerOwner === pending.ownerKey
    if (!sameSocket && !sameOwner) {
      logger.warn(`QQ relay response rejected: ${socketId} is not the target of ${requestId}`)
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    if (!sameSocket) {
      logger.info(`QQ relay response accepted after reconnect: ${pending.socketId} -> ${socketId} (${requestId})`)
    }
    pending.resolve({ ok, data, error })
  }

  /**
   * 请求已开启中继的客户端代为发起 JSONP 请求。
   * 依次尝试最多 MAX_RELAY_CLIENTS 个空闲客户端，返回第一个成功回传的 JSON 数据；
   * 全部失败或超时返回 null。
   *
   * 注意：最坏耗时可达 `MAX_RELAY_CLIENTS × RELAY_TIMEOUT_MS`，调用方
   * （房间播放锁的共享预算）会从外部截断，因此这里不再叠加额外上限。
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
      logger.info(`QQ relay request emitted: ${requestId} -> ${socketId}`)
      const result = await this.requestOnce(socketId, requestId, url)
      if (result?.ok && result.data !== undefined) {
        logger.info(`QQ relay responded ok: ${requestId}`)
        return result.data
      }
      if (result && !result.ok) {
        logger.warn(
          `QQ relay client reported failure: ${requestId} (${String((result as { error?: string }).error ?? 'no reason')})`,
        )
      }
    }
    if (tried === 0) {
      logger.info('QQ relay skipped: no idle client with relay enabled')
    }
    return null
  }

  private requestOnce(
    socketId: string,
    requestId: string,
    url: string,
  ): Promise<{ ok: boolean; data?: unknown; error?: string } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        logger.warn(`QQ relay request timed out: ${requestId} -> ${socketId}`)
        resolve(null)
      }, RELAY_TIMEOUT_MS)
      this.pending.set(requestId, {
        socketId,
        ownerKey: this.owners.get(socketId) ?? '',
        requestId,
        timer,
        resolve,
      })
      this.io!.to(socketId).emit(EVENTS.MUSIC_RELAY_REQUEST, { requestId, url })
    })
  }
}

export const musicRelayService = new MusicRelayService()
