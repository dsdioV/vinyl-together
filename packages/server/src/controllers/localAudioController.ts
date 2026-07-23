import {
  EVENTS,
  ERROR_CODE,
  localAudioAssetDeleteSchema,
  localAudioAssetUpdateSchema,
  localAudioTaskCancelSchema,
} from '@music-together/shared'
import type { TypedServer, TypedSocket } from '../middleware/types.js'
import { createWithRoom } from '../middleware/withRoom.js'
import { checkSocketRateLimit } from '../middleware/socketRateLimiter.js'
import { localAudioErrorPayload, localAudioService } from '../services/localAudioService.js'

/** Socket.IO control plane for room-local audio tasks and assets. */
export function registerLocalAudioController(io: TypedServer, socket: TypedSocket): void {
  const withRoom = createWithRoom(io)

  const emitError = (target: TypedSocket, error: unknown): void => {
    const payload = localAudioErrorPayload(error)
    target.emit(EVENTS.ROOM_ERROR, payload)
  }

  socket.on(
    EVENTS.LOCAL_AUDIO_STATE_REQUEST,
    withRoom(async (ctx) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      localAudioService.emitSnapshot(ctx.roomId, ctx.socket)
    }),
  )

  socket.on(
    EVENTS.LOCAL_AUDIO_TASK_CANCEL,
    withRoom(async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = localAudioTaskCancelSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的本地音频任务' })
        return
      }
      try {
        const cancelled = await localAudioService.cancelTask(ctx.roomId, parsed.data.taskId, ctx.user)
        if (!cancelled) {
          ctx.socket.emit(EVENTS.ROOM_ERROR, {
            code: ERROR_CODE.LOCAL_AUDIO_NOT_FOUND,
            message: '任务不存在或已经结束',
          })
        }
      } catch (error) {
        emitError(ctx.socket, error)
      }
    }),
  )

  socket.on(
    EVENTS.LOCAL_AUDIO_ASSET_UPDATE,
    withRoom(async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = localAudioAssetUpdateSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的本地音频信息' })
        return
      }
      try {
        localAudioService.updateAsset(ctx.roomId, parsed.data.assetId, ctx.user, parsed.data)
      } catch (error) {
        emitError(ctx.socket, error)
      }
    }),
  )

  socket.on(
    EVENTS.LOCAL_AUDIO_ASSET_DELETE,
    withRoom(async (ctx, raw) => {
      if (!(await checkSocketRateLimit(ctx.socket))) return
      const parsed = localAudioAssetDeleteSchema.safeParse(raw)
      if (!parsed.success) {
        ctx.socket.emit(EVENTS.ROOM_ERROR, { code: ERROR_CODE.INVALID_DATA, message: '无效的本地音频删除请求' })
        return
      }
      try {
        const deleted = await localAudioService.deleteAsset(
          ctx.roomId,
          parsed.data.assetId,
          ctx.user,
          parsed.data.removeFromQueue,
        )
        if (!deleted) {
          ctx.socket.emit(EVENTS.ROOM_ERROR, {
            code: ERROR_CODE.LOCAL_AUDIO_NOT_FOUND,
            message: '本地音频不存在',
          })
        }
      } catch (error) {
        emitError(ctx.socket, error)
      }
    }),
  )
}
