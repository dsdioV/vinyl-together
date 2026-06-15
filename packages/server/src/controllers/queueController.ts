import {
  EVENTS,
  ERROR_CODE,
  queueAddSchema,
  queueAddBatchSchema,
  queueInsertAfterCurrentSchema,
  queueRemoveSchema,
  queueReorderSchema,
  defaultQueueAddSchema,
  defaultQueueAddBatchSchema,
  defaultQueueRemoveSchema,
  queueLikeSchema,
  queueUnlikeSchema,
} from '@music-together/shared'
import type { Track } from '@music-together/shared'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { createWithPermission } from '../middleware/withControl.js'
import { createWithRoom } from '../middleware/withRoom.js'
import { checkSocketRateLimit } from '../middleware/socketRateLimiter.js'
import * as chatService from '../services/chatService.js'
import * as playerService from '../services/playerService.js'
import * as queueService from '../services/queueService.js'
import { logger } from '../utils/logger.js'

export function registerQueueController(io: TypedServer, socket: TypedSocket) {
  const withPermission = createWithPermission(io)

  socket.on(
    EVENTS.QUEUE_ADD,
    withPermission('add', 'Queue', async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = queueAddSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的歌曲数据' })
        return
      }
      const track: Track = { ...parsed.data.track, requestedBy: ctx.user.nickname }

      const added = queueService.addTrack(ctx.roomId, track)
      if (!added) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.QUEUE_FULL, message: '播放队列已满' })
        return
      }
      io.to(ctx.roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'insert', tracks: [track], atIndex: ctx.room.queue.length - 1 })

      // System message
      const msg = chatService.createSystemMessage(ctx.roomId, `${ctx.user.nickname} 点了一首「${track.title}」`)
      io.to(ctx.roomId).emit(EVENTS.CHAT_MESSAGE, msg)

      // If nothing was playing, auto-play this track.
      // Uses autoPlayIfEmpty which re-checks room.currentTrack inside the
      // per-room mutex, preventing concurrent QUEUE_ADD handlers from both
      // triggering playback.
      await playerService.autoPlayIfEmpty(io, ctx.roomId, track)

      logger.info(`Track added: ${track.title}`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.QUEUE_INSERT_AFTER_CURRENT,
    withPermission('add', 'Queue', async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = queueInsertAfterCurrentSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的歌曲数据' })
        return
      }
      const track: Track = { ...parsed.data.track, requestedBy: ctx.user.nickname }

      const insertIndex = queueService.insertAfterCurrent(ctx.roomId, track)
      if (insertIndex < 0) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.QUEUE_FULL, message: '播放队列已满' })
        return
      }
      io.to(ctx.roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'insert', tracks: [track], atIndex: insertIndex })

      // System message
      const msg = chatService.createSystemMessage(ctx.roomId, `${ctx.user.nickname} 置顶了一首「${track.title}」`)
      io.to(ctx.roomId).emit(EVENTS.CHAT_MESSAGE, msg)

      // If nothing was playing, auto-play this track.
      await playerService.autoPlayIfEmpty(io, ctx.roomId, track)

      logger.info(`Track inserted after current: ${track.title}`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.QUEUE_ADD_BATCH,
    withPermission('add', 'Queue', async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = queueAddBatchSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的歌曲数据' })
        return
      }
      const { tracks: rawTracks, playlistName } = parsed.data
      const tracks: Track[] = rawTracks.map((t) => ({ ...t, requestedBy: ctx.user.nickname }))

      const addedCount = queueService.addBatchTracks(ctx.roomId, tracks)
      if (addedCount === 0) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.QUEUE_FULL, message: '播放队列已满' })
        return
      }
      const addedTracks = tracks.slice(0, addedCount)
      io.to(ctx.roomId).emit(EVENTS.QUEUE_UPDATED, {
        type: 'insert',
        tracks: addedTracks,
        atIndex: ctx.room.queue.length - addedCount,
      })

      const label = playlistName ? `歌单「${playlistName}」` : '歌单'
      const msg = chatService.createSystemMessage(
        ctx.roomId,
        `${ctx.user.nickname} 从${label}导入了 ${addedCount} 首歌`,
      )
      io.to(ctx.roomId).emit(EVENTS.CHAT_MESSAGE, msg)

      // Auto-play first added track if nothing is playing
      if (addedCount > 0) {
        await playerService.autoPlayIfEmpty(io, ctx.roomId, tracks[0])
      }

      logger.info(`Batch added ${addedCount} tracks from playlist`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.QUEUE_REMOVE,
    withPermission('remove', 'Queue', async (ctx, raw) => {
      const parsed = queueRemoveSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的移除请求' })
        return
      }
      const { trackId } = parsed.data
      const isCurrentTrack = ctx.room.currentTrack?.id === trackId

      queueService.removeTrack(ctx.roomId, trackId)
      io.to(ctx.roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'remove', trackIds: [trackId] })

      // If the removed track was currently playing, skip to next or stop.
      // skipDebounce: removing current track must always advance, regardless
      // of how recently the last NEXT was triggered.
      if (isCurrentTrack) {
        await playerService.playNextTrackInRoom(io, ctx.roomId, ctx.room.playMode, { skipDebounce: true })
      }

      logger.info(`Track removed`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.QUEUE_REORDER,
    withPermission('reorder', 'Queue', (ctx, raw) => {
      const parsed = queueReorderSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的排序数据' })
        return
      }
      const { trackIds } = parsed.data
      queueService.reorderTracks(ctx.roomId, trackIds)
      io.to(ctx.roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'reorder', trackIds })
      logger.info(`Queue reordered`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.QUEUE_CLEAR,
    withPermission('remove', 'Queue', async (ctx) => {
      queueService.clearQueue(ctx.roomId)
      io.to(ctx.roomId).emit(EVENTS.QUEUE_UPDATED, { type: 'clear' })

      // Stop playback via mutex-protected variant to prevent races with
      // concurrent autoPlayIfEmpty from a simultaneous QUEUE_ADD.
      await playerService.stopPlaybackSafe(io, ctx.roomId)

      logger.info(`Queue cleared`, { roomId: ctx.roomId })
    }),
  )

  // -----------------------------------------------------------------------
  // Default queue (default playlist pool) — owner/admin only
  // -----------------------------------------------------------------------

  socket.on(
    EVENTS.DEFAULT_QUEUE_ADD,
    withPermission('add', 'Queue', (ctx, raw) => {
      const parsed = defaultQueueAddSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的歌曲数据' })
        return
      }
      const track: Track = { ...parsed.data.track, requestedBy: ctx.user.nickname }

      ctx.room.defaultQueue.push(track)
      io.to(ctx.roomId).emit(EVENTS.DEFAULT_QUEUE_UPDATED, { defaultQueue: ctx.room.defaultQueue })

      const msg = chatService.createSystemMessage(
        ctx.roomId,
        `${ctx.user.nickname} 将「${track.title}」加入了默认播放列表`,
      )
      io.to(ctx.roomId).emit(EVENTS.CHAT_MESSAGE, msg)

      logger.info(`Default queue add: ${track.title}`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.DEFAULT_QUEUE_ADD_BATCH,
    withPermission('add', 'Queue', (ctx, raw) => {
      const parsed = defaultQueueAddBatchSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的歌曲数据' })
        return
      }
      const { tracks: rawTracks } = parsed.data
      const tracks: Track[] = rawTracks.map((t) => ({ ...t, requestedBy: ctx.user.nickname }))

      ctx.room.defaultQueue.push(...tracks)
      io.to(ctx.roomId).emit(EVENTS.DEFAULT_QUEUE_UPDATED, { defaultQueue: ctx.room.defaultQueue })

      const msg = chatService.createSystemMessage(
        ctx.roomId,
        `${ctx.user.nickname} 添加了 ${tracks.length} 首歌到默认播放列表`,
      )
      io.to(ctx.roomId).emit(EVENTS.CHAT_MESSAGE, msg)

      logger.info(`Default queue batch add: ${tracks.length} tracks`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.DEFAULT_QUEUE_REMOVE,
    withPermission('remove', 'Queue', (ctx, raw) => {
      const parsed = defaultQueueRemoveSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的移除请求' })
        return
      }
      const { trackId } = parsed.data

      ctx.room.defaultQueue = ctx.room.defaultQueue.filter((t) => t.id !== trackId)
      io.to(ctx.roomId).emit(EVENTS.DEFAULT_QUEUE_UPDATED, { defaultQueue: ctx.room.defaultQueue })

      logger.info(`Default queue remove`, { roomId: ctx.roomId })
    }),
  )

  // -----------------------------------------------------------------------
  // Song likes — anyone in the room can like/unlike tracks
  // -----------------------------------------------------------------------

  socket.on(
    EVENTS.QUEUE_LIKE,
    createWithRoom(io)(async (ctx, raw) => {
      const parsed = queueLikeSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的点赞请求' })
        return
      }
      const { trackId } = parsed.data

      // Track must exist in queue or be currently playing
      const inQueue = ctx.room.queue.some((t) => t.id === trackId)
      const isCurrent = ctx.room.currentTrack?.id === trackId
      if (!inQueue && !isCurrent) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '歌曲不在播放列表中' })
        return
      }

      // Get or create the like set for this track
      let likeSet = ctx.room.trackLikes.get(trackId)
      if (!likeSet) {
        likeSet = new Set()
        ctx.room.trackLikes.set(trackId, likeSet)
      }

      // Already liked — no-op (idempotent)
      if (likeSet.has(ctx.user.id)) return

      likeSet.add(ctx.user.id)
      ctx.room.trackLikeTimestamps.set(trackId, Date.now())

      // Broadcast updated likes to all room members
      _broadcastLikes(io, ctx.roomId, ctx.room)

      logger.info(`Track liked: ${trackId} by ${ctx.user.nickname}`, { roomId: ctx.roomId })
    }),
  )

  socket.on(
    EVENTS.QUEUE_UNLIKE,
    createWithRoom(io)(async (ctx, raw) => {
      const parsed = queueUnlikeSchema.safeParse(raw)
      if (!parsed.success) {
        socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的取消点赞请求' })
        return
      }
      const { trackId } = parsed.data

      const likeSet = ctx.room.trackLikes.get(trackId)
      if (!likeSet || !likeSet.has(ctx.user.id)) return // Not liked — no-op

      likeSet.delete(ctx.user.id)

      // Clean up empty sets
      if (likeSet.size === 0) {
        ctx.room.trackLikes.delete(trackId)
        ctx.room.trackLikeTimestamps.delete(trackId)
      }

      // Broadcast updated likes
      _broadcastLikes(io, ctx.roomId, ctx.room)

      logger.info(`Track unliked: ${trackId} by ${ctx.user.nickname}`, { roomId: ctx.roomId })
    }),
  )
}

/** Serialize trackLikes Map → Record and broadcast to the room */
function _broadcastLikes(
  io: TypedServer,
  roomId: string,
  room: { trackLikes: Map<string, Set<string>> },
): void {
  const trackLikes: Record<string, string[]> = {}
  for (const [trackId, userIds] of room.trackLikes) {
    trackLikes[trackId] = Array.from(userIds)
  }
  io.to(roomId).emit(EVENTS.QUEUE_LIKES_UPDATED, { trackLikes })
}
