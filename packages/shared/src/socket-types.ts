import type { EVENTS } from './events.js'
import type {
  AudioQuality,
  ChatMessage,
  LocalAudioAsset,
  LocalAudioState,
  LocalAudioTask,
  MusicSource,
  MyPlatformAuth,
  PlayMode,
  Playlist,
  PlatformAuthStatus,
  PlayedTrack,
  RoomListItem,
  RoomState,
  ScheduledPlayState,
  Track,
  User,
  UserRole,
  VoteAction,
  VoteState,
  RoomAutoFallbackEvent,
} from './types.js'

/**
 * Legacy online-track input. Keep the source explicitly restricted to the
 * three providers so a local asset can only enter through LocalAudioTrackRef.
 */
export type ClientTrackInput = Omit<
  Track,
  'source' | 'assetId' | 'streamUrl' | 'fallbackStreamUrl' | 'localAudioAccessExpiresAt' | 'requestedBy'
> & {
  source: MusicSource
}

/**
 * Reference accepted for a room-local track. The server resolves this to a
 * canonical Track and supplies all metadata/URLs; clients must not send a
 * local file path or stream URL.
 */
export interface LocalAudioTrackRef {
  source: 'local'
  assetId: string
}

/** Queue input remains compatible with legacy full online Track payloads. */
export type QueueTrackInput = ClientTrackInput | LocalAudioTrackRef

/** 服务端 → 客户端 事件接口 */
export interface ServerToClientEvents {
  [EVENTS.ROOM_CREATED]: (data: { roomId: string; userId: string }) => void
  [EVENTS.ROOM_STATE]: (room: RoomState) => void
  [EVENTS.ROOM_REJOIN_TOKEN]: (data: { roomId: string; token: string; expiresAt: number }) => void
  [EVENTS.ROOM_ERROR]: (error: { code: string; message: string }) => void
  [EVENTS.ROOM_AUTO_FALLBACK]: (data: RoomAutoFallbackEvent) => void
  [EVENTS.ROOM_USER_JOINED]: (user: User) => void
  [EVENTS.ROOM_USER_LEFT]: (user: User) => void
  [EVENTS.ROOM_DELETED]: (data: { roomId: string }) => void
  [EVENTS.ROOM_SETTINGS]: (settings: {
    name: string
    hasPassword: boolean
    password?: string | null
    audioQuality: AudioQuality
    autoRemovePlayed: boolean
    songLikes: boolean
    voteThreshold?: number
    maxQueueSize: number
  }) => void
  [EVENTS.ROOM_LIST_UPDATE]: (rooms: RoomListItem[]) => void
  [EVENTS.ROOM_ROLE_CHANGED]: (data: { userId: string; role: UserRole }) => void

  [EVENTS.PLAYER_PLAY]: (data: { track: Track; playState: ScheduledPlayState }) => void
  [EVENTS.PLAYER_PAUSE]: (data: { playState: ScheduledPlayState }) => void
  [EVENTS.PLAYER_RESUME]: (data: { playState: ScheduledPlayState; track?: Track }) => void
  [EVENTS.PLAYER_SEEK]: (data: { playState: ScheduledPlayState }) => void
  [EVENTS.PLAYER_SYNC_RESPONSE]: (data: { currentTime: number; isPlaying: boolean; serverTimestamp: number }) => void

  // NTP clock sync
  [EVENTS.NTP_PONG]: (data: { clientPingId: number; serverTime: number }) => void

  [EVENTS.QUEUE_UPDATED]: (data: import('./types.js').QueueDelta) => void

  [EVENTS.CHAT_MESSAGE]: (message: ChatMessage) => void
  [EVENTS.CHAT_HISTORY]: (messages: ChatMessage[]) => void

  [EVENTS.VOTE_STARTED]: (vote: VoteState) => void
  [EVENTS.VOTE_RESULT]: (data: {
    passed: boolean
    action: VoteAction
    reason?: string
    payload?: Record<string, unknown>
  }) => void
  [EVENTS.VOTE_FORCE_APPROVE]: () => void
  [EVENTS.VOTE_FORCE_REJECT]: () => void

  // Auth
  [EVENTS.AUTH_QR_GENERATED]: (data: { key: string; qrimg: string }) => void
  [EVENTS.AUTH_QR_STATUS]: (data: { status: number; message: string }) => void
  [EVENTS.AUTH_SET_COOKIE_RESULT]: (data: {
    success: boolean
    message: string
    platform?: MusicSource
    cookie?: string
    reason?: 'expired' | 'error' | 'no_token'
  }) => void
  [EVENTS.AUTH_STATUS_UPDATE]: (data: PlatformAuthStatus[]) => void
  [EVENTS.AUTH_MY_STATUS]: (data: MyPlatformAuth[]) => void

  // Playlist
  [EVENTS.PLAYLIST_MY_LIST]: (data: { platform: MusicSource; playlists: Playlist[] }) => void

  // Default queue
  [EVENTS.DEFAULT_QUEUE_UPDATED]: (data: { defaultQueue: Track[] }) => void

  // Song likes
  [EVENTS.QUEUE_LIKES_UPDATED]: (data: { trackLikes: Record<string, string[]> }) => void

  // Played history
  [EVENTS.PLAYED_HISTORY_UPDATED]: (data: { playedHistory: PlayedTrack[] }) => void

  // Room-local audio
  [EVENTS.LOCAL_AUDIO_STATE]: (data: LocalAudioState) => void
  [EVENTS.LOCAL_AUDIO_TASK_UPDATED]: (task: LocalAudioTask) => void
  [EVENTS.LOCAL_AUDIO_TASK_REMOVED]: (data: { taskId: string }) => void
  [EVENTS.LOCAL_AUDIO_ASSET_UPDATED]: (asset: LocalAudioAsset) => void
  [EVENTS.LOCAL_AUDIO_ASSET_REMOVED]: (data: { assetId: string }) => void

  // QQ 音乐浏览器中继
  [EVENTS.MUSIC_RELAY_REQUEST]: (data: { requestId: string; url: string }) => void
}

/** 客户端 → 服务端 事件接口 */
export interface ClientToServerEvents {
  [EVENTS.ROOM_CREATE]: (data: {
    nickname: string
    roomName?: string
    password?: string
    persistent?: boolean
    persistentTtlHours?: number
    roomId?: string
  }) => void
  [EVENTS.ROOM_JOIN]: (data: { roomId: string; nickname: string; password?: string; rejoinToken?: string }) => void
  [EVENTS.ROOM_LEAVE]: () => void
  [EVENTS.ROOM_DELETE]: () => void
  [EVENTS.ROOM_LIST]: () => void
  [EVENTS.ROOM_SETTINGS]: (data: {
    name?: string
    password?: string | null
    audioQuality?: AudioQuality
    autoRemovePlayed?: boolean
    songLikes?: boolean
    voteThreshold?: number
    maxQueueSize?: number
  }) => void
  [EVENTS.ROOM_SET_ROLE]: (data: { userId: string; role: 'admin' | 'member' }) => void

  [EVENTS.PLAYER_PLAY]: (data?: { trackId?: string }) => void
  [EVENTS.PLAYER_PAUSE]: () => void
  [EVENTS.PLAYER_SEEK]: (data: { currentTime: number }) => void
  [EVENTS.PLAYER_NEXT]: () => void
  [EVENTS.PLAYER_PREV]: () => void
  [EVENTS.PLAYER_SYNC]: (data: { currentTime: number; hostServerTime?: number }) => void
  [EVENTS.PLAYER_SYNC_REQUEST]: () => void
  [EVENTS.PLAYER_SET_MODE]: (data: { mode: PlayMode }) => void

  [EVENTS.QUEUE_ADD]: (data: { track: QueueTrackInput }) => void
  [EVENTS.QUEUE_INSERT_AFTER_CURRENT]: (data: { track: QueueTrackInput }) => void
  [EVENTS.QUEUE_REMOVE]: (data: { trackId: string }) => void
  [EVENTS.QUEUE_REORDER]: (data: { trackIds: string[] }) => void
  [EVENTS.QUEUE_CLEAR]: () => void

  // Queue batch
  [EVENTS.QUEUE_ADD_BATCH]: (data: { tracks: QueueTrackInput[]; playlistName?: string }) => void

  // Song likes
  [EVENTS.QUEUE_LIKE]: (data: { trackId: string }) => void
  [EVENTS.QUEUE_UNLIKE]: (data: { trackId: string }) => void

  // Default queue
  [EVENTS.DEFAULT_QUEUE_ADD]: (data: { track: QueueTrackInput }) => void
  [EVENTS.DEFAULT_QUEUE_ADD_BATCH]: (data: { tracks: QueueTrackInput[] }) => void
  [EVENTS.DEFAULT_QUEUE_REMOVE]: (data: { trackId: string }) => void

  // Room-local audio
  [EVENTS.LOCAL_AUDIO_STATE_REQUEST]: () => void
  [EVENTS.LOCAL_AUDIO_TASK_CANCEL]: (data: { taskId: string }) => void
  [EVENTS.LOCAL_AUDIO_ASSET_UPDATE]: (data: {
    assetId: string
    title?: string
    artist?: string[]
    album?: string
  }) => void
  [EVENTS.LOCAL_AUDIO_ASSET_DELETE]: (data: { assetId: string; removeFromQueue?: boolean }) => void

  // QQ 音乐浏览器中继
  [EVENTS.RELAY_MODE_CHANGED]: (data: { enabled: boolean }) => void
  [EVENTS.MUSIC_RELAY_RESPONSE]: (data: { requestId: string; ok: boolean; data?: unknown; error?: string }) => void

  [EVENTS.CHAT_MESSAGE]: (data: { content: string }) => void

  [EVENTS.VOTE_START]: (data: { action: VoteAction; payload?: Record<string, unknown> }) => void
  [EVENTS.VOTE_CAST]: (data: { approve: boolean }) => void
  [EVENTS.VOTE_FORCE_APPROVE]: () => void
  [EVENTS.VOTE_FORCE_REJECT]: () => void

  // Auth
  [EVENTS.AUTH_REQUEST_QR]: (data: { platform: MusicSource }) => void
  [EVENTS.AUTH_CHECK_QR]: (data: { key: string; platform: MusicSource }) => void
  [EVENTS.AUTH_SET_COOKIE]: (data: { platform: MusicSource; cookie: string }) => void
  [EVENTS.AUTH_LOGOUT]: (data: { platform: MusicSource }) => void
  [EVENTS.AUTH_GET_STATUS]: () => void

  // Playlist
  [EVENTS.PLAYLIST_GET_MY]: (data: { platform: MusicSource }) => void

  // NTP clock sync
  [EVENTS.NTP_PING]: (data: { clientPingId: number; lastRttMs?: number }) => void
}
