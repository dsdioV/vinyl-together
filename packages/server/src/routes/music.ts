import {
  searchQuerySchema,
  urlQuerySchema,
  lyricQuerySchema,
  coverQuerySchema,
  playlistQuerySchema,
  playlistSearchQuerySchema,
  trackQuerySchema,
  sanitizeCoverProxyUrl,
  type MusicSource,
} from '@music-together/shared'
import { Router, type Router as RouterType, type Request, type Response } from 'express'
import type { ZodSchema } from 'zod'
import { musicProvider, PlaylistSearchLimitError } from '../services/musicProvider.js'
import { KugouShortCodeError } from '../services/kugouShortCodeService.js'
import * as authService from '../services/authService.js'
import { roomRepo } from '../repositories/roomRepository.js'
import { logger } from '../utils/logger.js'
import { readCoverResponse } from '../utils/coverResponse.js'
import { Readable } from 'node:stream'
import { z } from 'zod/v4'

const router: RouterType = Router()

type PlaylistCookieResult = { authorized: true; cookie: string | null } | { authorized: false }

function resolvePlaylistCookie(
  req: Request,
  res: Response,
  source: MusicSource,
  roomId?: string,
): PlaylistCookieResult {
  if (!roomId) return { authorized: true, cookie: null }

  const identityUserId = req.identityUserId
  if (!identityUserId) {
    res.status(401).json({ error: 'Unauthorized' })
    return { authorized: false }
  }

  const room = roomRepo.get(roomId)
  if (!room || !room.users.some((user) => user.id === identityUserId)) {
    res.status(403).json({ error: 'Forbidden' })
    return { authorized: false }
  }

  return {
    authorized: true,
    cookie: authService.getUserCookie(identityUserId, source, roomId),
  }
}

function respondPlaylistLimitError(res: Response, error: PlaylistSearchLimitError): void {
  res.status(422).json({
    error: error.message,
    code: error.code,
    maxTracks: error.maxTracks,
    ...(error.actualTracks === undefined ? {} : { actualTracks: error.actualTracks }),
  })
}

/**
 * Wrap an async route handler with validation + error handling.
 * Eliminates repeated try/catch + Zod boilerplate in each route.
 */
function validated<T>(
  schema: ZodSchema<T>,
  label: string,
  handler: (data: T, req: Request, res: Response) => Promise<void>,
) {
  return async (req: Request, res: Response) => {
    try {
      const parsed = schema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query parameters' })
        return
      }
      await handler(parsed.data, req, res)
    } catch (err) {
      logger.error(`${label} failed`, err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}

router.get(
  '/search',
  validated(searchQuerySchema, 'Search', async (data, _req, res) => {
    const { source, keyword, limit: pageSize, page: pageNum, type } = data
    if (type === 'album') {
      const albums = await musicProvider.searchAlbum(source, keyword, pageSize, pageNum)
      res.json({ tracks: albums, page: pageNum, hasMore: albums.length >= pageSize })
    } else if (type === 'playlist') {
      const playlists = await musicProvider.searchPlaylist(source, keyword, pageSize, pageNum)
      res.json({ tracks: playlists, page: pageNum, hasMore: playlists.length >= pageSize })
    } else {
      const tracks = await musicProvider.search(source, keyword, pageSize, pageNum)
      res.json({ tracks, page: pageNum, hasMore: tracks.length >= pageSize })
    }
  }),
)

router.get(
  '/url',
  validated(urlQuerySchema, 'Get stream URL', async (data, _req, res) => {
    const { source, urlId, bitrate } = data
    const url = await musicProvider.getStreamUrl(source, urlId, bitrate)
    res.json({ url })
  }),
)

/**
 * bilibili 音频流代理：浏览器媒体请求无法携带 bilibili 的 Referer，CDN 会 403；
 * 由服务端带 Referer 拉流并转发 Range，主 CDN 失败时自动切换到 backupUrl。
 */
router.get(
  '/bilibili/stream',
  validated(
    z.object({
      id: z.string().regex(/^(?:BV[0-9A-Za-z]+|av\d+)$/i, '无效的 bilibili 视频 ID'),
      cid: z.coerce.number().int().positive().optional(),
      bitrate: z.coerce.number().int().min(1).max(999).default(320),
    }),
    'Bilibili stream proxy',
    async (data, req, res) => {
      const result = await musicProvider.getStreamUrlResult('bilibili', data.id, data.bitrate)
      const candidates = [result.url, result.backupUrl].filter((u): u is string => Boolean(u))
      if (candidates.length === 0) {
        res.status(502).json({ error: '无法获取 bilibili 播放链接' })
        return
      }

      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63',
        Referer: 'https://www.bilibili.com/',
      }
      if (typeof req.headers.range === 'string') headers.Range = req.headers.range
      if (typeof req.headers['if-range'] === 'string') headers['If-Range'] = req.headers['if-range']

      for (const candidate of candidates) {
        try {
          const upstream = await fetch(candidate, { headers, redirect: 'error' })
          if (!upstream.ok && upstream.status !== 206) {
            logger.warn(`bilibili stream candidate failed: ${upstream.status}`, { id: data.id })
            continue
          }
          res.status(upstream.status)
          for (const name of [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'cache-control',
            'etag',
            'last-modified',
            'expires',
          ]) {
            const value = upstream.headers.get(name)
            if (value) res.setHeader(name, value)
          }
          const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
          body.on('error', () => res.destroy())
          req.on('close', () => body.destroy())
          body.pipe(res)
          return
        } catch (err) {
          logger.error('bilibili stream candidate fetch failed', err, { id: data.id })
        }
      }

      if (!res.headersSent) res.status(502).json({ error: 'bilibili 音频流获取失败' })
      else res.end()
    },
  ),
)

router.get(
  '/lyric',
  validated(lyricQuerySchema, 'Get lyric', async (data, _req, res) => {
    const { source, lyricId } = data
    const result = await musicProvider.getLyric(source, lyricId)
    res.json(result)
  }),
)

router.get(
  '/cover',
  validated(coverQuerySchema, 'Get cover', async (data, _req, res) => {
    const { source, picId, size } = data
    const url = await musicProvider.getCover(source, picId, size)
    res.json({ url })
  }),
)

router.get(
  '/playlist',
  validated(playlistQuerySchema, 'Get playlist', async (data, req, res) => {
    const { source, id, limit, offset, total, roomId, type } = data

    const auth = resolvePlaylistCookie(req, res, source, roomId)
    if (!auth.authorized) return

    try {
      const result = await musicProvider.getPlaylistPage(source, id, limit, offset, total, auth.cookie, type)
      res.json({ tracks: result.tracks, total: result.total, offset, hasMore: result.hasMore })
    } catch (error) {
      if (error instanceof PlaylistSearchLimitError) {
        respondPlaylistLimitError(res, error)
        return
      }
      throw error
    }
  }),
)

router.get(
  '/playlist/search',
  validated(playlistSearchQuerySchema, 'Search playlist', async (data, req, res) => {
    const { source, id, keyword, page, limit, total, roomId, type } = data
    const auth = resolvePlaylistCookie(req, res, source, roomId)
    if (!auth.authorized) return

    try {
      const result = await musicProvider.searchPlaylistTracks(
        source,
        id,
        keyword,
        page,
        limit,
        total,
        auth.cookie,
        type,
      )
      res.json({ tracks: result.tracks, total: result.total, page, hasMore: result.hasMore })
    } catch (error) {
      if (error instanceof PlaylistSearchLimitError) {
        respondPlaylistLimitError(res, error)
        return
      }
      throw error
    }
  }),
)

router.get(
  '/track',
  validated(trackQuerySchema, 'Get track by ID', async (data, _req, res) => {
    let cookie: string | null = null
    if (data.roomId) {
      const identityUserId = _req.identityUserId
      if (identityUserId) {
        const room = roomRepo.get(data.roomId)
        if (room && room.users.some((u) => u.id === identityUserId)) {
          cookie = authService.getUserCookie(identityUserId, data.source, data.roomId)
        }
      }
    }

    let track
    try {
      track = await musicProvider.getTrackById(data.source, data.id, cookie)
    } catch (error) {
      if (error instanceof KugouShortCodeError) {
        res.status(error.httpStatus).json({ error: error.message, code: error.code })
        return
      }
      throw error
    }
    if (!track) {
      res.status(404).json({ error: '歌曲未找到' })
      return
    }
    res.json({ track })
  }),
)

// ---------------------------------------------------------------------------
// 封面图片代理 — 解决外部 CDN（如 QQ 音乐 y.gtimg.cn）的 CORS 限制
// AMLL 的 BackgroundRender 用 WebGL 纹理加载图片，需要同源或 CORS 允许
// ---------------------------------------------------------------------------
router.get('/cover-proxy', async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string | undefined
  if (!imageUrl) {
    res.status(400).json({ error: 'Missing url parameter' })
    return
  }

  try {
    const safeImageUrl = sanitizeCoverProxyUrl(imageUrl)
    if (!safeImageUrl) {
      res.status(403).json({ error: 'Host not allowed' })
      return
    }

    const response = await fetch(safeImageUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'error',
    })

    if (!response.ok) {
      res.status(response.status).json({ error: 'Upstream fetch failed' })
      return
    }

    // 分块读取并限制实际（解压后）大小；读取异常仍会被当前 try/catch 捕获。
    const cover = await readCoverResponse(response)
    if (!cover.ok) {
      res.status(cover.status).json({ error: cover.error })
      return
    }

    res.setHeader('Content-Type', cover.contentType)
    res.setHeader('Content-Length', String(cover.buffer.length))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'public, max-age=86400') // 24h 缓存
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.status(200).end(cover.buffer)
  } catch (err) {
    logger.error('Cover proxy failed', err, { imageUrl })
    if (!res.headersSent) {
      res.status(504).json({ error: 'Cover proxy failed' })
    } else {
      res.end()
    }
  }
})

export default router
