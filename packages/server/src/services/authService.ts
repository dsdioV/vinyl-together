import type { MusicSource, PlatformAuthStatus, MyPlatformAuth } from '@music-together/shared'
import { logger } from '../utils/logger.js'

/**
 * Room-scoped cookie pool for music platform authentication.
 * Cookies are stored per-room so a user's VIP only benefits the room they're in.
 * Cookies are NOT removed when a user disconnects — they stay until the room is destroyed.
 * This ensures queued VIP songs can still play after the contributor leaves.
 */

interface CookieEntry {
  cookie: string
  userId: string
  nickname: string
  /** 0 = no VIP, 1 = VIP, 11 = 黑胶 (Netease specific) */
  vipType: number
  timestamp: number
  /**
   * 上游是否**明确确认**该凭证仍有效。
   *
   * 仅当平台能可靠区分时才有意义（目前只有 QQ 音乐）。false 表示「未能确认」，
   * 不代表已过期——UI 据此显示「登录状态待确认」而不是伪装成正常登录。
   * 缺失（undefined）表示该平台不做此区分。
   */
  credentialVerified?: boolean
}

/** roomId -> (platform -> list of cookie entries) */
const roomCookiePool = new Map<string, Map<MusicSource, CookieEntry[]>>()

/**
 * 已判定过期的凭证指纹（roomId:platform:userId）。
 *
 * 过期凭证**不会**写入房间池，但没有入池就无法通过池查询把「已过期」这个结论
 * 回传给前端。这里单独记一份，供 getUserAuthStatus 标记 expired。
 * 清理时机与房间池一致（cleanupRoom / 重新登录成功时删除）。
 */
const expiredCredentialKeys = new Set<string>()

function expiredKey(roomId: string, platform: MusicSource, userId: string): string {
  return `${roomId}:${platform}:${userId}`
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getRoomPool(roomId: string): Map<MusicSource, CookieEntry[]> {
  let pool = roomCookiePool.get(roomId)
  if (!pool) {
    pool = new Map()
    roomCookiePool.set(roomId, pool)
  }
  return pool
}

function getPlatformEntries(roomId: string, platform: MusicSource): CookieEntry[] {
  const pool = getRoomPool(roomId)
  let entries = pool.get(platform)
  if (!entries) {
    entries = []
    pool.set(platform, entries)
  }
  return entries
}

// ---------------------------------------------------------------------------
// Pool management
// ---------------------------------------------------------------------------

export function addCookie(
  roomId: string,
  platform: MusicSource,
  userId: string,
  cookie: string,
  nickname: string,
  vipType: number,
  credentialVerified?: boolean,
): void {
  const entries = getPlatformEntries(roomId, platform)
  // Dedup by cookie value (same account) or by userId (same socket)
  const idx = entries.findIndex((e) => e.cookie === cookie || e.userId === userId)
  let existingTimestamp = Date.now()
  if (idx !== -1) {
    existingTimestamp = entries[idx].timestamp // Preserve original login timestamp if just updating
    entries.splice(idx, 1)
  }
  entries.push({ cookie, userId, nickname, vipType, timestamp: existingTimestamp, credentialVerified })
  // 重新登录成功：清掉该用户此前的过期标记
  expiredCredentialKeys.delete(expiredKey(roomId, platform, userId))
  logger.info(`Auth: ${nickname} added cookie for ${platform} in room ${roomId} (vipType=${vipType})`)
}

/**
 * 记录「该用户在此平台的凭证已被上游判定过期」。
 *
 * 过期凭证不入池（否则会被 getAnyCookie 取去播放，产生 104003），
 * 但需要留下标记，让前端能显示「登录已失效 · 重新扫码」而不是「未登录」或
 * 更糟的「已登录但没 VIP」。
 */
export function markCredentialExpired(
  roomId: string,
  platform: MusicSource,
  userId: string,
  nickname?: string,
): void {
  expiredCredentialKeys.add(expiredKey(roomId, platform, userId))
  logger.info(`Auth: ${nickname ?? userId} credential for ${platform} expired in room ${roomId}`)
}

/** 该用户在此平台的凭证是否已被判定过期。 */
export function isCredentialExpired(roomId: string, platform: MusicSource, userId: string): boolean {
  return expiredCredentialKeys.has(expiredKey(roomId, platform, userId))
}

export function removeCookie(roomId: string, platform: MusicSource, userId: string): boolean {
  expiredCredentialKeys.delete(expiredKey(roomId, platform, userId))
  const pool = roomCookiePool.get(roomId)
  if (!pool) return false
  const entries = pool.get(platform)
  if (!entries) return false
  const idx = entries.findIndex((e) => e.userId === userId)
  if (idx === -1) return false
  const removed = entries.splice(idx, 1)[0]
  logger.info(`Auth: removed cookie for ${platform} from user ${removed.nickname} in room ${roomId}`)
  return true
}

/**
 * Clean up all cookies for a room. Called when the room is destroyed.
 */
export function cleanupRoom(roomId: string): void {
  const prefix = `${roomId}:`
  for (const key of expiredCredentialKeys) {
    if (key.startsWith(prefix)) expiredCredentialKeys.delete(key)
  }
  if (roomCookiePool.delete(roomId)) {
    logger.info(`Auth: cleaned up cookie pool for destroyed room ${roomId}`)
  }
}

/**
 * Check if a specific cookie value already exists for the given room + platform.
 * Used to skip redundant validation on auto-resend.
 */
export function hasCookie(roomId: string, platform: MusicSource, cookie: string): boolean {
  const pool = roomCookiePool.get(roomId)
  if (!pool) return false
  const entries = pool.get(platform)
  if (!entries) return false
  return entries.some((e) => e.cookie === cookie)
}

// ---------------------------------------------------------------------------
// Cookie retrieval
// ---------------------------------------------------------------------------

/**
 * Get any available cookie for a platform in a specific room.
 * Prefers VIP cookies over non-VIP.
 */
export function getAnyCookie(platform: MusicSource, roomId: string): string | null {
  const pool = roomCookiePool.get(roomId)
  if (!pool) return null
  const entries = pool.get(platform)
  if (!entries || entries.length === 0) return null

  // 单次遍历取最高 vipType 的 cookie（O(n) 替代排序 O(n log n)）
  let best = entries[0]
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].vipType > best.vipType) best = entries[i]
  }
  return best.cookie
}

/**
 * Get a specific user's cookie for a platform in a specific room.
 * Used for user-private operations like fetching personal playlists.
 */
export function getUserCookie(userId: string, platform: MusicSource, roomId: string): string | null {
  const pool = roomCookiePool.get(roomId)
  if (!pool) return null
  const entries = pool.get(platform)
  if (!entries) return null
  const entry = entries.find((e) => e.userId === userId)
  return entry?.cookie ?? null
}

// ---------------------------------------------------------------------------
// Status for frontend
// ---------------------------------------------------------------------------

/**
 * Get aggregated auth status for all platforms in a specific room.
 */
export function getAllPlatformStatus(roomId: string): PlatformAuthStatus[] {
  const platforms: MusicSource[] = ['netease', 'tencent', 'kugou']
  const pool = roomCookiePool.get(roomId)
  return platforms.map((platform) => {
    const entries = pool?.get(platform) ?? []
    const maxVipType = entries.reduce((max, e) => Math.max(max, e.vipType), 0)
    
    // Find the earliest VIP user's timestamp
    const vipEntries = entries.filter(e => e.vipType > 0)
    const earliestVipTimestamp = vipEntries.length > 0 
      ? Math.min(...vipEntries.map(e => e.timestamp))
      : undefined

    return {
      platform,
      loggedInCount: entries.length,
      hasVip: maxVipType > 0,
      maxVipType,
      earliestVipTimestamp,
    }
  })
}

/**
 * Get a specific user's auth status across all platforms in a specific room.
 */
export function getUserAuthStatus(userId: string, roomId: string): MyPlatformAuth[] {
  const platforms: MusicSource[] = ['netease', 'tencent', 'kugou']
  const pool = roomCookiePool.get(roomId)
  return platforms.map((platform) => {
    const entries = pool?.get(platform) ?? []
    const entry = entries.find((e) => e.userId === userId)
    return {
      platform,
      loggedIn: !!entry,
      nickname: entry?.nickname,
      vipType: entry?.vipType,
      // 上一次校验被上游判定为过期（凭证未入池）。前端据此显示「登录已失效」。
      expired: !entry && isCredentialExpired(roomId, platform, userId),
      credentialVerified: entry?.credentialVerified,
    }
  })
}
