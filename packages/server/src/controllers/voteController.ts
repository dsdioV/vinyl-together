import {
  EVENTS,
  ERROR_CODE,
  TIMING,
  defineAbilityFor,
  voteStartSchema,
  voteCastSchema,
  playerSetModeSchema,
} from '@music-together/shared'
import type { Actions, Subjects, PlayMode, VoteAction } from '@music-together/shared'
import { createWithRoom } from '../middleware/withRoom.js'
import { checkSocketRateLimit } from '../middleware/socketRateLimiter.js'
import { roomRepo } from '../repositories/roomRepository.js'
import * as voteService from '../services/voteService.js'
import * as playerService from '../services/playerService.js'
import * as queueService from '../services/queueService.js'
import * as roomService from '../services/roomService.js'
import { logger } from '../utils/logger.js'
import type { TypedServer, TypedSocket } from '../middleware/types.js'

/**
 * Execute the voted action on the player.
 * No initiatorSocket — broadcast to everyone since this is a collective decision.
 */
async function executeAction(
  io: TypedServer,
  roomId: string,
  action: VoteAction,
  payload?: Record<string, unknown>,
): Promise<void> {
  switch (action) {
    case 'pause':
      playerService.pauseTrack(io, roomId)
      break
    case 'resume':
      playerService.resumeTrack(io, roomId)
      break
    case 'next': {
      const room = roomRepo.get(roomId)
      await playerService.playNextTrackInRoom(io, roomId, room?.playMode ?? 'sequential', { skipDebounce: true })
      break
    }
    case 'prev': {
      await playerService.playPrevTrackInRoom(io, roomId, { skipDebounce: true })
      break
    }
    case 'set-mode': {
      const parsed = playerSetModeSchema.safeParse(payload)
      if (!parsed.success) {
        io.to(roomId).emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_INPUT, message: '无效的播放模式' })
        break
      }
      const room = roomRepo.get(roomId)
      if (!room) break
      room.playMode = parsed.data.mode
      io.to(roomId).emit(EVENTS.ROOM_STATE, roomService.toPublicRoomState(room))
      logger.info(`Play mode set to ${parsed.data.mode} via vote`, { roomId })
      break
    }
    case 'play-track': {
      const trackId = payload?.trackId
      if (typeof trackId !== 'string') {
        io.to(roomId).emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_INPUT, message: '无效的歌曲 ID' })
        break
      }
      const room = roomRepo.get(roomId)
      if (!room) break
      const track = room.queue.find((t) => t.id === trackId)
      if (track) {
        await playerService.playTrackInRoom(io, roomId, track)
        logger.info(`Play-track executed for track ${trackId}`, { roomId })
      } else {
        io.to(roomId).emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_INPUT, message: '歌曲不在播放列表中' })
      }
      break
    }
    case 'remove-track': {
      const trackId = payload?.trackId
      if (typeof trackId !== 'string') {
        io.to(roomId).emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_INPUT, message: '无效的歌曲 ID' })
        break
      }
      const room = roomRepo.get(roomId)
      if (!room) break
      const isCurrentTrack = room.currentTrack?.id === trackId
      queueService.removeTrack(roomId, trackId)
      io.to(roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: [trackId] })
      if (isCurrentTrack) {
        await playerService.playNextTrackInRoom(io, roomId, room.playMode, { skipDebounce: true })
      }
      logger.info(`Remove-track executed for track ${trackId}`, { roomId })
      break
    }
  }
}

export function registerVoteController(io: TypedServer, socket: TypedSocket) {
  const withRoom = createWithRoom(io)

  socket.on(
    EVENTS.VOTE_START,
    withRoom(async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = voteStartSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_INPUT, message: '无效的投票请求' })
        return
      }

      const { action, payload } = parsed.data

      // 验证：所有用户都必须有投票权限才能发起投票
      const ability = defineAbilityFor(ctx.user.role)
      if (!ability.can('vote', 'Player')) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.NO_PERMISSION, message: '你没有投票权限' })
        return
      }

      const vote = voteService.createVote(ctx.roomId, ctx.room.hostId, ctx.user, action, ctx.room.users.length, ctx.room.voteThreshold, payload)

      if (!vote) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.VOTE_IN_PROGRESS, message: '已有投票正在进行中' })
        return
      }

      // Check if the vote is already decided (e.g. only 1-2 users in the room)
      const approveCount = Object.values(vote.votes).filter(Boolean).length
      if (approveCount >= vote.requiredVotes) {
        // Auto-pass: execute immediately
        clearTimeout(vote.timeoutHandle)
        await executeAction(io, ctx.roomId, action, vote.payload)
        io.to(ctx.roomId).emit(EVENTS.VOTE_RESULT, { passed: true, action })
        voteService.cancelVote(ctx.roomId)
        return
      }

      // Set timeout for auto-reject
      vote.timeoutHandle = setTimeout(() => {
        io.to(ctx.roomId).emit(EVENTS.VOTE_RESULT, { passed: false, action, reason: 'timeout' })
        voteService.cancelVote(ctx.roomId)
        logger.info(`Vote timed out: ${action} in room ${ctx.roomId}`, { roomId: ctx.roomId })
      }, TIMING.VOTE_TIMEOUT_MS)

      // Broadcast vote started
      io.to(ctx.roomId).emit(EVENTS.VOTE_STARTED, voteService.toVoteState(vote))
    }),
  )

  socket.on(
    EVENTS.VOTE_CAST,
    withRoom(async (ctx, raw) => {
      const parsed = voteCastSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_INPUT, message: '无效的投票数据' })
        return
      }

      const result = voteService.castVote(ctx.roomId, ctx.user.id, parsed.data.approve)
      if (!result) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.ALREADY_VOTED, message: '你已经投过票了' })
        return
      }

      // Broadcast updated vote state
      io.to(ctx.roomId).emit(EVENTS.VOTE_STARTED, voteService.toVoteState(result.vote))

      if (result.decided) {
        clearTimeout(result.vote.timeoutHandle)

        if (result.passed) {
          await executeAction(io, ctx.roomId, result.vote.action, result.vote.payload)
        }

        io.to(ctx.roomId).emit(EVENTS.VOTE_RESULT, {
          passed: result.passed,
          action: result.vote.action,
          reason: result.reason,
        })

        voteService.cancelVote(ctx.roomId)
      }
    }),
  )

  // ---- Force approve / reject vote (owner/admin only) ----
  socket.on(
    EVENTS.VOTE_FORCE_APPROVE,
    withRoom(async (ctx) => {
      if (ctx.user.role === 'owner' || ctx.user.role === 'admin') {
        const result = voteService.forceApprove(ctx.roomId)
        if (result) {
          await executeAction(io, ctx.roomId, result.action, result.payload)
          io.to(ctx.roomId).emit(EVENTS.VOTE_RESULT, { passed: true, action: result.action, reason: 'force_approved' })
          logger.info(`Vote force-approved by ${ctx.user.nickname} (role: ${ctx.user.role})`, { roomId: ctx.roomId })
        }
      } else {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.NO_PERMISSION, message: '只有房主和管理员可以强制通过' })
      }
    }),
  )

  socket.on(
    EVENTS.VOTE_FORCE_REJECT,
    withRoom(async (ctx) => {
      if (ctx.user.role === 'owner' || ctx.user.role === 'admin') {
        const vote = voteService.getActiveVote(ctx.roomId)
        if (vote && voteService.forceReject(ctx.roomId)) {
          io.to(ctx.roomId).emit(EVENTS.VOTE_RESULT, { passed: false, action: vote.action, reason: 'force_rejected' })
          logger.info(`Vote force-rejected by ${ctx.user.nickname} (role: ${ctx.user.role})`, { roomId: ctx.roomId })
        }
      } else {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.NO_PERMISSION, message: '只有房主和管理员可以强制否决' })
      }
    }),
  )
}
