/**
 * Room Lifecycle Service
 *
 * Manages timers (room deletion) and debounced lobby broadcasts.
 * Extracted from roomService to separate lifecycle/timer concerns from CRUD logic
 * and eliminate the circular dependency (roomService -> playerController -> roomService).
 *
 * Dependency direction:
 *   roomService -> roomLifecycleService -> (repos, playerService, voteService, authService)
 *   roomLifecycleService does NOT depend on roomService (no circular risk).
 *
 * Note: Role grace period has been removed. Owner role is permanent (based on creatorId),
 * admin is persisted via adminUserIds, and conductor (hostId) is auto-elected by
 * electConductor() in roomService whenever users join/leave.
 */

import type { RoomListItem } from '@music-together/shared'
import { EVENTS } from '@music-together/shared'
import { config } from '../config.js'
import type { TypedServer } from '../middleware/types.js'
import { chatRepo } from '../repositories/chatRepository.js'
import { roomRepo } from '../repositories/roomRepository.js'
import { logger } from '../utils/logger.js'
import { cleanupRoom as cleanupAuthRoom } from './authService.js'
import { cleanupRoom as cleanupPlayerRoom } from './playerService.js'
import { cleanupRoom as cleanupVoteRoom } from './voteService.js'
import { cleanupRoomRejoinTickets } from './rejoinTicketService.js'

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** 宽限期定时器：房间变空后延迟删除，给断线用户重连的窗口 */
const roomDeletionTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 防抖广播：100ms trailing debounce */
let broadcastTimer: ReturnType<typeof setTimeout> | null = null
let pendingIO: TypedServer | null = null

// ---------------------------------------------------------------------------
// Room deletion timer
// ---------------------------------------------------------------------------

/** 清理房间所有关联数据 */
function deleteRoomData(roomId: string): void {
  roomRepo.delete(roomId)
  chatRepo.deleteRoom(roomId)
  cleanupPlayerRoom(roomId)
  cleanupVoteRoom(roomId)
  cleanupAuthRoom(roomId)
  cleanupRoomRejoinTickets(roomId)
}

export function scheduleDeletion(roomId: string, io?: TypedServer): void {
  // Prevent duplicate timers if called multiple times for the same room
  cancelDeletionTimer(roomId)

  const room = roomRepo.get(roomId)
  if (!room) return

  // 持久化房间：TTL=0 永不清除，TTL>0 按小时计
  if (room.persistent) {
    if (room.persistentTtlHours <= 0) {
      logger.info(`Room ${roomId} is persistent — skipping deletion`, { roomId })
      return
    }
    const ttlMs = room.persistentTtlHours * 3_600_000
    logger.info(
      `Room ${roomId} is persistent, will be deleted in ${room.persistentTtlHours}h unless someone rejoins`,
      { roomId },
    )
    const timer = setTimeout(() => {
      const r = roomRepo.get(roomId)
      if (r && r.users.length === 0) {
        deleteRoomData(roomId)
        logger.info(`Room ${roomId} deleted after ${room!.persistentTtlHours}h TTL (persistent)`, { roomId })
        if (io) broadcastRoomList(io)
      }
      roomDeletionTimers.delete(roomId)
    }, ttlMs)
    roomDeletionTimers.set(roomId, timer)
    return
  }

  // 非持久化房间：短时间断线重连窗口
  logger.info(
    `Room ${roomId} is empty, will be deleted in ${config.room.gracePeriodMs / 1000}s unless someone rejoins`,
    { roomId },
  )
  const timer = setTimeout(() => {
    const r = roomRepo.get(roomId)
    if (r && r.users.length === 0) {
      deleteRoomData(roomId)
      logger.info(`Room ${roomId} deleted after grace period`, { roomId })
      if (io) broadcastRoomList(io)
    }
    roomDeletionTimers.delete(roomId)
  }, config.room.gracePeriodMs)
  roomDeletionTimers.set(roomId, timer)
}

export function cancelDeletionTimer(roomId: string): void {
  const timer = roomDeletionTimers.get(roomId)
  if (timer) {
    clearTimeout(timer)
    roomDeletionTimers.delete(roomId)
    logger.info(`Room ${roomId} deletion cancelled — user rejoined`, { roomId })
  }
}

// ---------------------------------------------------------------------------
// Debounced lobby broadcast
// ---------------------------------------------------------------------------

/**
 * 向 lobby 频道广播房间列表变更（100ms trailing 防抖）。
 * 多次快速调用（如 create+join、多人同时 leave）会合并为一次广播，
 * 避免重复执行 getAllAsList() 遍历和序列化。
 */
export function broadcastRoomList(io: TypedServer): void {
  pendingIO = io
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    if (pendingIO) {
      const rooms: RoomListItem[] = roomRepo.getAllAsList()
      pendingIO.to('lobby').emit(EVENTS.ROOM_LIST_UPDATE, rooms)
    }
  }, 100)
}

// ---------------------------------------------------------------------------
// Shutdown cleanup — clear all module-level timers
// ---------------------------------------------------------------------------

/** Clear all timers managed by this module. Call during graceful shutdown. */
export function clearAllTimers(): void {
  // Room deletion timers
  for (const timer of roomDeletionTimers.values()) clearTimeout(timer)
  roomDeletionTimers.clear()

  // Broadcast debounce timer
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  pendingIO = null

  logger.info('All roomLifecycleService timers cleared')
}
