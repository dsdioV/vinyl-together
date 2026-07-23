import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { Request, Response } from 'express'
import { json, Router, type Router as RouterType } from 'express'
import * as z from 'zod/v4'
import { ERROR_CODE, localAudioAssetDeleteSchema, localAudioAssetUpdateSchema } from '@music-together/shared'
import { roomRepo } from '../repositories/roomRepository.js'
import { localAudioService, localAudioErrorPayload } from '../services/localAudioService.js'
import { verifyLocalAudioAccessToken, type LocalAudioAccessVariant } from '../services/localAudioAccess.js'
import { isPathInsideRoot, parseByteRange } from '../services/localAudioMedia.js'
import {
  checkLocalAudioHttpRateLimit,
  LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE,
  type LocalAudioHttpRateLimitKind,
} from '../middleware/localAudioHttpRateLimiter.js'
import { config } from '../config.js'

const createTaskSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.coerce.number().int().positive(),
  addToQueue: z.boolean().optional().default(true),
})

function validRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9_-]{1,20}$/.test(roomId)
}

function validAssetId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value)
}

function requireMember(req: Request, res: Response, roomId: string) {
  if (!validRoomId(roomId)) {
    res.status(400).json({ error: 'Invalid room ID' })
    return null
  }
  if (!req.identityUserId) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  const room = roomRepo.get(roomId)
  if (!room) {
    res.status(404).json({ error: 'Room not found' })
    return null
  }
  const user = room.users.find((candidate) => candidate.id === req.identityUserId)
  if (!user) {
    res.status(403).json({ error: 'Room membership required' })
    return null
  }
  return { room, user: { id: user.id, nickname: user.nickname, role: user.role } }
}

function sendLocalError(res: Response, error: unknown): void {
  const payload = localAudioErrorPayload(error)
  const status =
    payload.code === ERROR_CODE.NO_PERMISSION ? 403 : payload.code === ERROR_CODE.LOCAL_AUDIO_NOT_FOUND ? 404 : 400
  res.status(status).json({ error: payload.message, code: payload.code, message: payload.message })
}

async function requireRateLimit(res: Response, userId: string, kind: LocalAudioHttpRateLimitKind): Promise<boolean> {
  if (await checkLocalAudioHttpRateLimit(userId, kind)) return true
  res.status(429).json({
    error: LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE,
    code: ERROR_CODE.RATE_LIMITED,
    message: LOCAL_AUDIO_HTTP_RATE_LIMIT_MESSAGE,
  })
  return false
}

function routeVariant(value: string): LocalAudioAccessVariant | null {
  if (value === 'stream') return 'primary'
  if (value === 'fallback') return 'fallback'
  if (value === 'cover') return 'cover'
  return null
}

async function serveVariant(
  req: Request,
  res: Response,
  roomId: string,
  assetId: string,
  variant: LocalAudioAccessVariant,
): Promise<void> {
  if (!validRoomId(roomId) || !validAssetId(assetId)) {
    res.status(404).end()
    return
  }
  const room = roomRepo.get(roomId)
  if (!room) {
    res.status(404).end()
    return
  }
  const isMember = Boolean(req.identityUserId && room.users.some((user) => user.id === req.identityUserId))
  const tokenValid = verifyLocalAudioAccessToken(String(req.query.token ?? ''), { roomId, assetId, variant })
  if (!isMember && !tokenValid) {
    res.status(req.identityUserId ? 403 : 401).end()
    return
  }

  const info = localAudioService.getVariant(roomId, assetId, variant)
  if (!info || !isPathInsideRoot(config.localAudio.dataDir, info.path)) {
    res.status(404).end()
    return
  }
  let size: number
  let fileRealPath: string
  try {
    const [rootRealPath, resolvedFilePath] = await Promise.all([
      realpath(config.localAudio.dataDir),
      realpath(info.path),
    ])
    fileRealPath = resolvedFilePath
    if (!isPathInsideRoot(rootRealPath, fileRealPath)) {
      res.status(404).end()
      return
    }
    const fileStat = await stat(fileRealPath)
    if (!fileStat.isFile()) {
      res.status(404).end()
      return
    }
    // Trust the filesystem at request time rather than a stale in-memory size
    // if an operator or a cleanup race changed the generated file.
    size = fileStat.size
  } catch {
    res.status(404).end()
    return
  }

  const pipeFile = (range?: { start: number; end: number }): void => {
    const fileStream = createReadStream(fileRealPath, range)
    const closeStream = () => {
      if (!fileStream.destroyed) fileStream.destroy()
      if (!res.destroyed) res.destroy()
    }
    const release = localAudioService.beginStream(info.asset, closeStream)
    res.once('close', () => {
      if (!fileStream.destroyed) fileStream.destroy()
      release()
    })
    res.once('finish', release)
    fileStream.once('close', release)
    fileStream.on('error', () => {
      if (!res.destroyed) res.destroy()
    })
    fileStream.pipe(res)
  }

  res.setHeader('Content-Type', info.contentType)
  res.setHeader('Content-Disposition', 'inline')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, max-age=300')
  if (variant === 'cover') {
    res.setHeader('Content-Length', String(size))
    if (req.method === 'HEAD') {
      res.status(200).end()
      return
    }
    pipeFile()
    return
  }

  res.setHeader('Accept-Ranges', 'bytes')
  const parsed = parseByteRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)
  if (parsed.kind === 'invalid') {
    res.setHeader('Content-Range', parsed.contentRange)
    res.status(416).end()
    return
  }

  if (parsed.kind === 'ok') {
    const { start, end, length } = parsed.range
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', String(length))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    pipeFile({ start, end })
    return
  }

  res.status(200)
  res.setHeader('Content-Length', String(size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeFile()
}

const router: RouterType = Router()
const localAudioJson = json({ limit: '32kb' })

router.get('/:roomId/local-audio', async (req, res) => {
  const auth = requireMember(req, res, req.params.roomId)
  if (!auth) return
  if (!(await requireRateLimit(res, auth.user.id, 'snapshot'))) return
  res.json(localAudioService.snapshot(req.params.roomId))
})

router.post('/:roomId/local-audio/tasks', localAudioJson, async (req, res) => {
  const auth = requireMember(req, res, req.params.roomId)
  if (!auth) return
  if (!(await requireRateLimit(res, auth.user.id, 'mutation'))) return
  const parsed = createTaskSchema.safeParse(req.body)
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? '无效的上传任务', code: ERROR_CODE.LOCAL_AUDIO_INVALID })
    return
  }
  try {
    const task = await localAudioService.createTask(req.params.roomId, auth.user, parsed.data)
    res.status(201).json({ task })
  } catch (error) {
    sendLocalError(res, error)
  }
})

router.put('/:roomId/local-audio/tasks/:taskId/content', async (req, res) => {
  const auth = requireMember(req, res, req.params.roomId)
  if (!auth) return
  if (!(await requireRateLimit(res, auth.user.id, 'mutation'))) return
  const contentLengthHeader = req.headers['content-length']
  const contentLength = typeof contentLengthHeader === 'string' ? Number(contentLengthHeader) : NaN
  try {
    const task = await localAudioService.receiveUpload({
      taskId: req.params.taskId,
      roomId: req.params.roomId,
      actor: auth.user,
      request: req,
      contentLength,
    })
    res.status(202).json({ task })
  } catch (error) {
    if (!res.headersSent) sendLocalError(res, error)
  }
})

router.delete('/:roomId/local-audio/tasks/:taskId', async (req, res) => {
  const auth = requireMember(req, res, req.params.roomId)
  if (!auth) return
  if (!(await requireRateLimit(res, auth.user.id, 'mutation'))) return
  try {
    const ok = await localAudioService.cancelTask(req.params.roomId, req.params.taskId, auth.user)
    if (!ok) {
      res.status(404).json({ error: '任务不存在或已完成', code: ERROR_CODE.LOCAL_AUDIO_NOT_FOUND })
      return
    }
    res.status(204).end()
  } catch (error) {
    sendLocalError(res, error)
  }
})

router.patch('/:roomId/local-audio/assets/:assetId', localAudioJson, async (req, res) => {
  const auth = requireMember(req, res, req.params.roomId)
  if (!auth) return
  if (!(await requireRateLimit(res, auth.user.id, 'mutation'))) return
  const parsed = localAudioAssetUpdateSchema.safeParse({ assetId: req.params.assetId, ...req.body })
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? '无效的元数据', code: ERROR_CODE.LOCAL_AUDIO_INVALID })
    return
  }
  try {
    const asset = localAudioService.updateAsset(req.params.roomId, req.params.assetId, auth.user, parsed.data)
    res.json({ asset })
  } catch (error) {
    sendLocalError(res, error)
  }
})

router.delete('/:roomId/local-audio/assets/:assetId', async (req, res) => {
  const auth = requireMember(req, res, req.params.roomId)
  if (!auth) return
  if (!(await requireRateLimit(res, auth.user.id, 'mutation'))) return
  const parsed = localAudioAssetDeleteSchema.safeParse({
    assetId: req.params.assetId,
    removeFromQueue: req.query.removeFromQueue === 'true' || req.query.removeFromQueue === '1',
  })
  if (!parsed.success) {
    res.status(400).json({ error: '无效的删除请求', code: ERROR_CODE.LOCAL_AUDIO_INVALID })
    return
  }
  try {
    const ok = await localAudioService.deleteAsset(
      req.params.roomId,
      req.params.assetId,
      auth.user,
      parsed.data.removeFromQueue,
    )
    if (!ok) {
      res.status(404).json({ error: '本地音频不存在', code: ERROR_CODE.LOCAL_AUDIO_NOT_FOUND })
      return
    }
    res.status(204).end()
  } catch (error) {
    sendLocalError(res, error)
  }
})

const serveVariantRoute = async (req: Request, res: Response): Promise<void> => {
  const roomId = typeof req.params.roomId === 'string' ? req.params.roomId : ''
  const assetId = typeof req.params.assetId === 'string' ? req.params.assetId : ''
  const variantParam = typeof req.params.variant === 'string' ? req.params.variant : ''
  const variant = routeVariant(variantParam)
  if (!variant) {
    res.status(404).end()
    return
  }
  await serveVariant(req, res, roomId, assetId, variant)
}

router.get('/:roomId/local-audio/assets/:assetId/:variant', serveVariantRoute)
router.head('/:roomId/local-audio/assets/:assetId/:variant', serveVariantRoute)

export default router
