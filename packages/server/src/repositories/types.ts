import type { AudioQuality, ChatMessage, PlayMode, PlayState, PlayedTrack, RoomListItem, Track, User } from '@music-together/shared'

/** 服务端内部房间数据模型 -- 含密码（永远不发送给客户端） */
export interface RoomData {
  id: string
  name: string
  password: string | null
  /** 房间创建者 ID（永久不变，创建者为 owner，加入时自动成为 conductor） */
  creatorId: string
  hostId: string
  /** 持久化 admin 用户 ID 集合（离开/回来自动恢复 admin） */
  adminUserIds: Set<string>
  audioQuality: AudioQuality
  users: User[]
  queue: Track[]
  /** 默认播放列表池，主队列为空时从中随机抽取 */
  defaultQueue: Track[]
  currentTrack: Track | null
  playState: PlayState
  playMode: PlayMode
  /** 播完自动移出队列（房主开关，默认关闭） */
  autoRemovePlayed: boolean
  /** 点赞模式（房主开关，需 autoRemovePlayed 开启，默认关闭） */
  songLikes: boolean
  /** 房间持久化：开启后即使无人也不会被自动删除 */
  persistent: boolean
  /** 持久化房间的 TTL（小时），0 = 永不清除，上限 168 小时 */
  persistentTtlHours: number
  /** 点赞数据：trackId → 点赞用户ID集合 */
  trackLikes: Map<string, Set<string>>
  /** 点赞时间戳（tiebreaker）：trackId → 最近点赞时间戳 */
  trackLikeTimestamps: Map<string, number>
  /** 投票通过率 (0.01–1.0)，默认 0.67 */
  voteThreshold: number
  /** 已播放歌曲历史记录 */
  playedHistory: PlayedTrack[]
}

export interface SocketMapping {
  roomId: string
  userId: string
}

export interface RoomRepository {
  get(roomId: string): RoomData | undefined
  set(roomId: string, room: RoomData): void
  delete(roomId: string): void
  getAll(): ReadonlyMap<string, RoomData>
  getAllIds(): string[]
  getAllAsList(): RoomListItem[]
  setSocketMapping(socketId: string, roomId: string, userId: string): void
  getSocketMapping(socketId: string): SocketMapping | undefined
  deleteSocketMapping(socketId: string): void
  /** Check if a user has another active socket in the same room (excluding a specific socket) */
  hasOtherSocketForUser(roomId: string, userId: string, excludeSocketId: string): boolean
  /** 根据 roomId + userId 查找对应的 socketId（用于定向发送） */
  getSocketIdForUser(roomId: string, userId: string): string | null
  /** Store a smoothed RTT measurement for a given socket */
  setSocketRTT(socketId: string, rttMs: number): void
  /** Retrieve the current smoothed RTT for a socket (default 0) */
  getSocketRTT(socketId: string): number
  /** Get the P90 RTT among all sockets in a room (falls back to max for ≤3 sockets) */
  getP90RTT(roomId: string): number
}

export interface ChatRepository {
  getHistory(roomId: string): ChatMessage[]
  addMessage(roomId: string, message: ChatMessage): void
  createRoom(roomId: string): void
  deleteRoom(roomId: string): void
}
