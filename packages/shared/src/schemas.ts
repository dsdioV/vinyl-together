import * as z from 'zod/v4'
import { LIMITS } from './constants.js'
import { sanitizeTrackCoverUrl } from './coverUrl.js'

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export const roomCreateSchema = z.object({
  nickname: z.string().min(1, '昵称不能为空').max(LIMITS.NICKNAME_MAX_LENGTH, '昵称过长'),
  roomName: z.string().max(LIMITS.ROOM_NAME_MAX_LENGTH, '房间名过长').optional(),
  password: z.string().max(LIMITS.ROOM_PASSWORD_MAX_LENGTH, '密码过长').optional(),
  persistent: z.boolean().optional(),
  persistentTtlHours: z.number().int().min(0).max(LIMITS.PERSISTENT_TTL_MAX_HOURS).optional(),
  roomId: z
    .string()
    .regex(/^[A-Z0-9]+$/, '房间号只能包含大写字母和数字')
    .min(LIMITS.ROOM_ID_CUSTOM_MIN_LENGTH, `房间号至少${LIMITS.ROOM_ID_CUSTOM_MIN_LENGTH}位`)
    .max(LIMITS.ROOM_ID_CUSTOM_MAX_LENGTH, `房间号最多${LIMITS.ROOM_ID_CUSTOM_MAX_LENGTH}位`)
    .optional(),
})

export const roomJoinSchema = z.object({
  roomId: z.string().min(1, '房间号不能为空'),
  nickname: z.string().min(1, '昵称不能为空'),
  password: z.string().max(LIMITS.ROOM_PASSWORD_MAX_LENGTH).optional(),
  rejoinToken: z.string().min(1).max(500).optional(),
})

export const audioQualitySchema = z.union([z.literal(128), z.literal(192), z.literal(320), z.literal(999)])

export const roomSettingsSchema = z.object({
  name: z.string().min(1).max(LIMITS.ROOM_NAME_MAX_LENGTH).optional(),
  password: z.string().max(LIMITS.ROOM_PASSWORD_MAX_LENGTH).nullable().optional(),
  audioQuality: audioQualitySchema.optional(),
  autoRemovePlayed: z.boolean().optional(),
  songLikes: z.boolean().optional(),
  voteThreshold: z.number().min(0.01).max(1).optional(),
  maxQueueSize: z.number().int().min(LIMITS.QUEUE_MAX_SIZE_MIN).max(LIMITS.QUEUE_MAX_SIZE_MAX).optional(),
})

export const setRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['admin', 'member']),
})

// ---------------------------------------------------------------------------
// Room — auto fallback notifications
// ---------------------------------------------------------------------------

export const roomAutoFallbackSchema = z.object({
  attemptId: z.string().min(1).max(100),
  status: z.enum(['trying', 'success', 'failed']),
  fromSource: z.enum(['netease', 'tencent']),
  toSource: z.enum(['netease', 'tencent']),
  trackTitle: z.string().min(1).max(500),
  reasonType: z.enum(['VIP_REQUIRED', 'COPYRIGHT_RESTRICTED', 'NO_RESOURCE', 'TIMEOUT', 'UNKNOWN']).optional(),
  reasonDetail: z.string().max(200).optional(),
})

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

const trackIdSchema = z.string().min(1).max(200)

export const playerPlaySchema = z.union([
  z.strictObject({ trackId: trackIdSchema.optional() }),
  // Backward compatibility for already-open clients. Only the ID survives;
  // every other Track field (especially streamUrl) is discarded.
  z.strictObject({ track: z.object({ id: trackIdSchema }) }),
])

export const playerSeekSchema = z.object({
  currentTime: z.number().finite().nonnegative(),
})

export const playerSyncSchema = z.object({
  currentTime: z.number().finite().nonnegative(),
  hostServerTime: z.number().finite().positive().optional(),
})

export const playerSetModeSchema = z.object({
  mode: z.enum(['sequential', 'loop-all', 'loop-one', 'shuffle']),
})

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * Track fields accepted from clients. Stream URLs, local asset IDs, and
 * `requestedBy` are deliberately omitted so Zod strips these server-owned
 * fields at the socket boundary.
 */
const clientTrackSchema = z
  .object({
    id: z.string().max(200),
    title: z.string().max(500),
    artist: z.array(z.string().max(200)).max(20),
    album: z.string().max(500),
    duration: z.number().finite().nonnegative(),
    cover: z.string().max(2000),
    source: z.enum(['netease', 'tencent', 'kugou', 'bilibili', 'bandcamp']),
    sourceId: z.string().max(200),
    urlId: z.string().max(200),
    mediaMid: z.string().max(200).optional(),
    bilibiliCid: z.number().int().positive().optional(),
    lyricId: z.string().max(200).optional(),
    picId: z.string().max(200).optional(),
    vip: z.boolean().optional(),
  })
  .transform((track) => ({
    ...track,
    cover: sanitizeTrackCoverUrl(track.cover, track.source),
  }))

const localAudioIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, '无效的本地音频 ID')

/**
 * Local queue inputs are references only. strictObject deliberately rejects
 * client-supplied metadata, covers, paths, and stream URLs.
 */
export const localAudioTrackRefSchema = z.strictObject({
  source: z.literal('local'),
  assetId: localAudioIdSchema,
})

export const queueTrackInputSchema = z.union([clientTrackSchema, localAudioTrackRefSchema])

export const queueAddSchema = z.object({
  track: queueTrackInputSchema,
})

export const queueInsertAfterCurrentSchema = queueAddSchema

export const queueAddBatchSchema = z.object({
  tracks: z.array(queueTrackInputSchema).min(1).max(LIMITS.QUEUE_BATCH_MAX_SIZE),
  playlistName: z.string().max(200).optional(),
})

export const queueRemoveSchema = z.object({ trackId: z.string().max(200) })
export const queueReorderSchema = z.object({
  trackIds: z.array(z.string().max(200)).max(LIMITS.QUEUE_MAX_SIZE_MAX),
})

// ---------------------------------------------------------------------------
// Default queue (default playlist pool)
// ---------------------------------------------------------------------------

export const defaultQueueAddSchema = z.object({
  track: queueTrackInputSchema,
})

export const defaultQueueAddBatchSchema = z.object({
  tracks: z.array(queueTrackInputSchema).min(1).max(LIMITS.QUEUE_BATCH_MAX_SIZE),
})

export const defaultQueueRemoveSchema = z.object({ trackId: z.string().max(200) })

/**
 * 默认播放列表按轻量引用批量追加（跨房间存档恢复）。
 * 仅接受在线音源引用：本地资产随房间销毁，无法跨房间恢复，客户端导出时应剔除。
 * 元数据（封面/时长等）由服务端在播放时经 resolveDefaultQueueRef 懒补全。
 */
export const defaultQueueImportRefSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.enum(['netease', 'tencent', 'kugou', 'bilibili', 'bandcamp']),
  sourceId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  artist: z.array(z.string().max(200)).max(20),
})

export const defaultQueueAddRefsSchema = z.object({
  refs: z.array(defaultQueueImportRefSchema).min(1).max(LIMITS.QUEUE_BATCH_MAX_SIZE),
})

/** 默认播放列表批量元数据补全查询（REST：ids 逗号分隔，服务端按批大小上限截断） */
export const defaultQueueTracksQuerySchema = z.object({
  roomId: z.string().min(1).max(200),
  ids: z.string().min(1).max(2000),
})

// ---------------------------------------------------------------------------
// Room-local audio
// ---------------------------------------------------------------------------

export const localAudioTaskCancelSchema = z.strictObject({
  taskId: localAudioIdSchema,
})

export const localAudioAssetUpdateSchema = z
  .strictObject({
    assetId: localAudioIdSchema,
    title: z.string().trim().min(1).max(500).optional(),
    artist: z.array(z.string().trim().min(1).max(200)).min(1).max(20).optional(),
    album: z.string().trim().max(500).optional(),
  })
  .refine(
    (data) => data.title !== undefined || data.artist !== undefined || data.album !== undefined,
    '至少需要修改一个字段',
  )

export const localAudioAssetDeleteSchema = z.strictObject({
  assetId: localAudioIdSchema,
  removeFromQueue: z.boolean().optional().default(false),
})

// ---------------------------------------------------------------------------
// Song likes
// ---------------------------------------------------------------------------

export const queueLikeSchema = z.object({ trackId: z.string().max(200) })
export const queueUnlikeSchema = queueLikeSchema

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export const chatMessageSchema = z.object({
  content: z.string().min(1).max(LIMITS.CHAT_CONTENT_MAX_LENGTH),
})

// ---------------------------------------------------------------------------
// REST API – Music routes
// ---------------------------------------------------------------------------

const musicSourceSchema = z.enum(['netease', 'tencent', 'kugou', 'bilibili', 'bandcamp'])

export const searchQuerySchema = z.object({
  source: musicSourceSchema,
  keyword: z.string().min(1).max(LIMITS.SEARCH_KEYWORD_MAX_LENGTH),
  limit: z.coerce.number().int().min(1).max(LIMITS.SEARCH_PAGE_SIZE_MAX).default(20),
  page: z.coerce.number().int().min(1).max(LIMITS.SEARCH_PAGE_MAX).default(1),
  type: z.enum(['song', 'album', 'playlist']).optional().default('song'),
})

export const urlQuerySchema = z.object({
  source: musicSourceSchema,
  urlId: z.string().min(1),
  bitrate: z.coerce.number().int().positive().default(320),
})

export const lyricQuerySchema = z.object({
  source: musicSourceSchema,
  lyricId: z.string().min(1),
})

export const coverQuerySchema = z.object({
  source: musicSourceSchema,
  picId: z.string().min(1),
  size: z.coerce.number().int().positive().default(300),
})

export const trackQuerySchema = z.object({
  source: musicSourceSchema,
  id: z.string().min(1).max(LIMITS.PLAYLIST_ID_MAX_LENGTH),
  roomId: z.string().min(1).max(10).optional(),
})

export const playlistQuerySchema = z.object({
  source: musicSourceSchema,
  id: z.string().min(1).max(LIMITS.PLAYLIST_ID_MAX_LENGTH),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  total: z.coerce.number().int().min(0).optional(),
  roomId: z.string().min(1).max(10).optional(),
  type: z.enum(['playlist', 'album']).optional().default('playlist'),
})

export const playlistSearchQuerySchema = z.object({
  source: musicSourceSchema,
  id: z.string().trim().min(1).max(LIMITS.PLAYLIST_ID_MAX_LENGTH),
  keyword: z.string().trim().min(1).max(LIMITS.SEARCH_KEYWORD_MAX_LENGTH),
  page: z.coerce.number().int().min(1).max(LIMITS.PLAYLIST_SEARCH_PAGE_MAX).default(1),
  // Full-playlist search deliberately uses a fixed page size so the page
  // ceiling always covers the complete supported 10,000-track range.
  limit: z.coerce
    .number()
    .int()
    .min(LIMITS.PLAYLIST_SEARCH_PAGE_SIZE)
    .max(LIMITS.PLAYLIST_SEARCH_PAGE_SIZE)
    .default(LIMITS.PLAYLIST_SEARCH_PAGE_SIZE),
  total: z.coerce.number().int().min(0).optional(),
  roomId: z.string().min(1).max(10).optional(),
  type: z.enum(['playlist', 'album']).optional().default('playlist'),
})

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

export const voteStartSchema = z.object({
  action: z.enum(['pause', 'resume', 'next', 'prev', 'set-mode', 'play-track', 'remove-track']),
  payload: z.record(z.string(), z.unknown()).optional(),
})

export const voteCastSchema = z.object({
  approve: z.boolean(),
})
