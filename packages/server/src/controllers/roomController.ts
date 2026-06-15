import {
  ERROR_CODE,
  EVENTS,
  roomCreateSchema,
  roomJoinSchema,
  roomSettingsSchema,
  setRoleSchema,
} from '@music-together/shared'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { createWithOwnerOnly } from '../middleware/withControl.js'
import { createWithRoom } from '../middleware/withRoom.js'
import { cleanupSocketRateLimit } from '../middleware/socketRateLimiter.js'
import { roomRepo } from '../repositories/roomRepository.js'
import * as chatService from '../services/chatService.js'
import * as playerService from '../services/playerService.js'
import { issueRejoinTicket, revokeRejoinTickets } from '../services/rejoinTicketService.js'
import * as roomService from '../services/roomService.js'
import * as voteService from '../services/voteService.js'
import { logger } from '../utils/logger.js'

export function registerRoomController(io: TypedServer, socket: TypedSocket) {
  const withOwnerOnly = createWithOwnerOnly(io)

  // ---- Room list (不需要在房间内) ----
  socket.on(EVENTS.ROOM_LIST, () => {
    try {
      socket.emit(EVENTS.ROOM_LIST_UPDATE, roomService.listRooms())
    } catch (err) {
      logger.error('ROOM_LIST handler error', err, { socketId: socket.id })
    }
  })

  // ---- Create room (含可选密码) ----
  socket.on(EVENTS.ROOM_CREATE, (raw) => {
    try {
      const parsed = roomCreateSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.INVALID_INPUT,
          message: parsed.error.issues[0]?.message ?? '输入格式错误',
        })
        return
      }
      const { nickname, roomName, password, persistent, persistentTtlHours } = parsed.data

      // Auto-leave any previous room before creating a new one
      handleLeave(io, socket, 'auto-leave before create', true)

      const { room, user } = roomService.createRoom(
        socket.id,
        nickname.trim(),
        roomName,
        password,
        socket.data.identityUserId,
        persistent,
        persistentTtlHours,
      )

      socket.leave('lobby')
      socket.join(room.id)
      socket.emit(EVENTS.ROOM_CREATED, { roomId: room.id, userId: user.id })
      // 创建者是 owner，发送含密码的完整状态
      socket.emit(EVENTS.ROOM_STATE, roomService.toPublicRoomStateForOwner(room))
      const rejoin = issueRejoinTicket(room.id, user.id)
      socket.emit(EVENTS.ROOM_REJOIN_TOKEN, { roomId: room.id, token: rejoin.token, expiresAt: rejoin.expiresAt })

      // 广播房间列表给大厅用户
      roomService.broadcastRoomList(io)
    } catch (err) {
      logger.error('ROOM_CREATE handler error', err, { socketId: socket.id })
      socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INTERNAL, message: '服务器内部错误' })
    }
  })

  // ---- Join room (含密码校验) ----
  socket.on(EVENTS.ROOM_JOIN, (raw) => {
    try {
      const parsed = roomJoinSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.INVALID_INPUT,
          message: parsed.error.issues[0]?.message ?? '输入格式错误',
        })
        return
      }
      const { roomId, nickname, password, rejoinToken } = parsed.data

      // Validate join request (password, rejoin scenarios) — pure business logic
      const validation = roomService.validateJoinRequest(
        roomId,
        socket.id,
        socket.data.identityUserId,
        password,
        rejoinToken,
      )
      if (!validation.valid) {
        socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE[validation.errorCode as keyof typeof ERROR_CODE] ?? ERROR_CODE.JOIN_FAILED,
          message: validation.errorMessage ?? '加入房间失败',
        })
        return
      }

      // Auto-leave any previous room (different from target) before joining
      const existingMapping = roomRepo.getSocketMapping(socket.id)
      if (existingMapping && existingMapping.roomId !== roomId) {
        handleLeave(io, socket, 'auto-leave before join', true)
      }

      const result = roomService.joinRoom(socket.id, roomId, nickname.trim(), socket.data.identityUserId)
      if (!result) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.JOIN_FAILED, message: '加入房间失败' })
        return
      }

      const { room: updatedRoom, user, hostChanged } = result
      const rejoin = issueRejoinTicket(roomId, user.id)

      socket.leave('lobby')
      socket.join(roomId)

      // Send full room state + chat history
      // Owner 收到含密码版本，其他成员收到不含密码版本
      const isOwner = user.role === 'owner'
      const stateForJoiner = isOwner
        ? roomService.toPublicRoomStateForOwner(updatedRoom)
        : roomService.toPublicRoomState(updatedRoom)
      socket.emit(EVENTS.ROOM_STATE, stateForJoiner)

      // If conductor changed (owner joined, etc.), broadcast to ALL OTHER clients.
      if (hostChanged) {
        socket.to(roomId).emit(EVENTS.ROOM_STATE, roomService.toPublicRoomState(updatedRoom))
      }
      socket.emit(EVENTS.ROOM_REJOIN_TOKEN, { roomId, token: rejoin.token, expiresAt: rejoin.expiresAt })
      socket.emit(EVENTS.CHAT_HISTORY, chatService.getHistory(roomId))

      // Sync playback state to the joining client (auto-resume, auto-play)
      playerService.syncPlaybackToSocket(io, socket, roomId, updatedRoom).catch((err) => {
        logger.error('syncPlaybackToSocket failed', err, { roomId })
      })

      // Send active vote state if one is in progress
      const activeVote = voteService.getActiveVote(roomId)
      if (activeVote) {
        socket.emit(EVENTS.VOTE_STARTED, voteService.toVoteState(activeVote))
      }

      // Notify others (skip for rejoin — they already know the user is in the room)
      if (!validation.isRejoin) {
        socket.to(roomId).emit(EVENTS.ROOM_USER_JOINED, user)
        // System message for user joined (server-authoritative)
        const joinMsg = chatService.createSystemMessage(roomId, `${user.nickname} 加入了房间`)
        io.to(roomId).emit(EVENTS.CHAT_MESSAGE, joinMsg)
      }

      // 更新大厅房间列表（人数变了）
      roomService.broadcastRoomList(io)
    } catch (err) {
      logger.error('ROOM_JOIN handler error', err, { socketId: socket.id })
      socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INTERNAL, message: '服务器内部错误' })
    }
  })

  // ---- Leave room (explicit user action) ----
  socket.on(EVENTS.ROOM_LEAVE, () => {
    try {
      logger.info(`ROOM_LEAVE event from ${socket.id}`, { socketId: socket.id })
      handleLeave(io, socket, undefined, true)
    } catch (err) {
      logger.error('ROOM_LEAVE handler error', err, { socketId: socket.id })
    }
  })

  // ---- Room settings ----
  // Owner：全部设置；Admin：仅可切换 autoRemovePlayed；Member：无权限
  const withRoomForSettings = createWithRoom(io)
  socket.on(
    EVENTS.ROOM_SETTINGS,
    withRoomForSettings((ctx, raw) => {
      const parsed = roomSettingsSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.INVALID_INPUT,
          message: parsed.error.issues[0]?.message ?? '输入格式错误',
        })
        return
      }

      const isOwner = ctx.user.role === 'owner'
      const isAdmin = ctx.user.role === 'admin'

      // Admin 只能改 autoRemovePlayed / songLikes，且请求中不能含有其他字段
      if (!isOwner && !isAdmin) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.NO_PERMISSION,
          message: '只有房主和管理员可以修改设置',
        })
        return
      }

      // 若非 owner，仅允许 autoRemovePlayed / songLikes / voteThreshold 变更
      if (!isOwner) {
        const hasRestrictedKeys = parsed.data.name !== undefined
          || parsed.data.password !== undefined
          || parsed.data.audioQuality !== undefined
        if (hasRestrictedKeys) {
          ctx.socket.emit(EVENTS.ROOM_ERROR, {
            code: ERROR_CODE.NO_PERMISSION,
            message: '只有房主可以修改房间名、密码和音质',
          })
          return
        }
      }

      // 验证：启用点赞模式需要先开启自动移出
      if (parsed.data.songLikes === true && !ctx.room.autoRemovePlayed) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.INVALID_INPUT,
          message: '启用点赞模式需要先开启「播完自动移出」',
        })
        return
      }

      roomService.updateSettings(ctx.roomId, {
        name: parsed.data.name,
        password: parsed.data.password,
        audioQuality: parsed.data.audioQuality,
        autoRemovePlayed: parsed.data.autoRemovePlayed,
        songLikes: parsed.data.songLikes,
        voteThreshold: parsed.data.voteThreshold,
      })

      const updatedRoom = roomRepo.get(ctx.roomId)
      if (!updatedRoom) return

      // 仅 owner 收到密码明文，其他成员只收到 hasPassword 标记
      const baseSettings = {
        name: updatedRoom.name,
        hasPassword: updatedRoom.password !== null,
        audioQuality: updatedRoom.audioQuality,
        autoRemovePlayed: updatedRoom.autoRemovePlayed,
        songLikes: updatedRoom.songLikes,
        voteThreshold: updatedRoom.voteThreshold,
      }
      // 给 owner 发送含密码的设置
      ctx.socket.emit(EVENTS.ROOM_SETTINGS, {
        ...baseSettings,
        password: updatedRoom.password ?? null,
        autoRemovePlayed: updatedRoom.autoRemovePlayed,
        songLikes: updatedRoom.songLikes,
        voteThreshold: updatedRoom.voteThreshold,
      })
      // 给房间内其他成员发送不含密码的设置
      ctx.socket.to(ctx.roomId).emit(EVENTS.ROOM_SETTINGS, baseSettings)

      logger.info(`Room ${ctx.roomId} settings updated`, { roomId: ctx.roomId })

      // 密码变更也要刷新大厅列表
      roomService.broadcastRoomList(io)
    }),
  )

  // ---- Set user role (仅房主) ----
  socket.on(
    EVENTS.ROOM_SET_ROLE,
    withOwnerOnly((ctx, raw) => {
      const parsed = setRoleSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, {
          code: ERROR_CODE.INVALID_INPUT,
          message: parsed.error.issues[0]?.message ?? '输入格式错误',
        })
        return
      }

      const { userId, role } = parsed.data
      const success = roomService.setUserRole(ctx.roomId, userId, role)
      if (!success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.SET_ROLE_FAILED, message: '无法设置该用户的角色' })
        return
      }

      io.to(ctx.roomId).emit(EVENTS.ROOM_ROLE_CHANGED, { userId, role })
      logger.info(`Role changed: ${userId} -> ${role} in room ${ctx.roomId}`, { roomId: ctx.roomId })
    }),
  )

  // ---- Disconnect ----
  socket.on('disconnect', (reason) => {
    try {
      logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`, { socketId: socket.id })
      handleLeave(io, socket)
      // Safety net: always clean up socket mapping, RTT data, and rate limiter.
      // handleLeave only cleans up if the socket was in a room, but
      // NTP_PING can store RTT even for sockets that never joined a room.
      roomRepo.deleteSocketMapping(socket.id)
      cleanupSocketRateLimit(socket)
    } catch (err) {
      logger.error('disconnect handler error', err, { socketId: socket.id })
    }
  })
}

// ---------------------------------------------------------------------------
// Unified leave handler (previously duplicated as autoLeaveCurrentRoom + handleLeave)
// ---------------------------------------------------------------------------

/**
 * Leave the current room (if any), notify other users, and update lobby.
 * Used by ROOM_LEAVE, disconnect, and auto-leave before create/join.
 */
function handleLeave(io: TypedServer, socket: TypedSocket, reason?: string, revokeTicket = false): void {
  const result = roomService.leaveRoom(socket.id, io)
  if (!result) return

  const { roomId, user, room, hostChanged, voteUpdated } = result
  if (revokeTicket) {
    revokeRejoinTickets(roomId, user.id)
  }
  socket.leave(roomId)
  socket.join('lobby')
  io.to(roomId).emit(EVENTS.ROOM_USER_LEFT, user)

  // System message for user left (server-authoritative)
  if (room && room.users.length > 0) {
    const leaveMsg = chatService.createSystemMessage(roomId, `${user.nickname} 离开了房间`)
    io.to(roomId).emit(EVENTS.CHAT_MESSAGE, leaveMsg)
  }

  // 房主变更时广播完整状态，确保所有客户端更新 hostId
  // 新 owner 收到含密码版本，其他成员不含密码
  if (hostChanged && room && room.users.length > 0) {
    const newOwner = room.users.find((u) => u.role === 'owner')
    const ownerSocketId = newOwner ? roomRepo.getSocketIdForUser(roomId, newOwner.id) : null
    if (ownerSocketId) {
      io.to(ownerSocketId).emit(EVENTS.ROOM_STATE, roomService.toPublicRoomStateForOwner(room))
      io.to(roomId).except(ownerSocketId).emit(EVENTS.ROOM_STATE, roomService.toPublicRoomState(room))
    } else {
      io.to(roomId).emit(EVENTS.ROOM_STATE, roomService.toPublicRoomState(room))
    }
  }

  // Broadcast updated vote state after threshold recalculation
  if (voteUpdated) {
    const activeVote = voteService.getActiveVote(roomId)
    if (activeVote) {
      io.to(roomId).emit(EVENTS.VOTE_STARTED, voteService.toVoteState(activeVote))
    }
  }

  // 更新大厅房间列表
  roomService.broadcastRoomList(io)

  if (reason) {
    logger.info(`${reason}: left room ${roomId} for socket ${socket.id}`, { roomId, socketId: socket.id })
  }
}
