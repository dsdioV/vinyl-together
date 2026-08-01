import Meting from '@meting/core'
import { get as kugouLrcGet, Format } from '@s4p/kugou-lrc'
import type { KrcInfo } from '@s4p/kugou-lrc'
import { LIMITS, type MusicSource, type Track } from '@music-together/shared'
import { createHash } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { nanoid } from 'nanoid'
import pLimit from 'p-limit'
import ncmApi from '@neteasecloudmusicapienhanced/api'
import * as kugouAuth from './kugouAuthService.js'
import * as tencentAuth from './tencentAuthService.js'
import { isKugouShortCode, KugouShortCodeError, resolveKugouShortCode } from './kugouShortCodeService.js'
import { logger } from '../utils/logger.js'
import { ensureNeteaseApiReady } from './neteaseApiBootstrap.js'

/** AMLL LyricLine 格式（与 @applemusic-like-lyrics/core 一致，避免引入 client 依赖） */
interface AmllLyricLine {
  words: Array<{ word: string; startTime: number; endTime: number; romanWord: string; obscene: boolean }>
  translatedLyric: string
  romanLyric: string
  startTime: number
  endTime: number
  isBG: boolean
  isDuet: boolean
}

/** 将 KRC 解析结果转为 AMLL LyricLine 格式 */
function krcToAmllLines(krcInfo: KrcInfo): AmllLyricLine[] {
  if (!krcInfo.items?.length) return []
  return krcInfo.items.map((line) => {
    if (!line.length) {
      return {
        words: [],
        translatedLyric: '',
        romanLyric: '',
        startTime: 0,
        endTime: 0,
        isBG: false,
        isDuet: false,
      }
    }
    const words = line.map((w) => ({
      word: w.word,
      startTime: Math.round(w.offset * 1000),
      endTime: Math.round((w.offset + w.duration) * 1000),
      romanWord: '',
      obscene: false,
    }))
    const first = words[0]!
    const last = words[words.length - 1]!
    return {
      words,
      translatedLyric: '',
      romanLyric: '',
      startTime: first.startTime,
      endTime: last.endTime,
      isBG: false,
      isDuet: false,
    }
  })
}

// ---------------------------------------------------------------------------
// Meting instance type (library has no TS declarations)
// ---------------------------------------------------------------------------
type MetingInstance = InstanceType<typeof Meting>

/** Parsed JSON from Meting API responses */
type MetingJson = Record<string, unknown>

/** Loosely typed ncmApi response (the library has no TS declarations). */
interface NcmApiResponse {
  body?: {
    code?: number
    songs?: Record<string, unknown>[]
    playlist?: Record<string, unknown>[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** Tencent 新版搜索 API 响应结构 */
interface TencentSearchResponse {
  code: number
  'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
    code: number
    data: {
      body: {
        song: {
          list: TencentSearchSong[]
        }
      }
      meta: {
        curpage: number
        perpage: number
        sum: number
        nextpage: number
      }
    }
  }
}

/** Tencent 搜索结果单曲结构 */
interface TencentSearchSong {
  id: number
  mid: string
  name: string
  title?: string
  interval: number
  singer: Array<{ id: number; mid: string; name: string }>
  album?: {
    id: number
    mid: string
    name: string
    title?: string
    pmid?: string
  }
  file?: {
    media_mid?: string
    size_128mp3?: number
    size_320mp3?: number
    size_flac?: number
  }
  pay?: {
    pay_down?: number
    pay_month?: number
    pay_play?: number
    price_track?: number
  }
  action?: {
    msgpay?: number
  }
}

/** External API timeout (ms) */
const API_TIMEOUT_MS = 15_000
/** QQ 音乐 CDN fallback：vkey 响应未携带 sip 时使用。 */
const TENCENT_STREAM_FALLBACK_DOMAIN = 'https://isure.stream.qqmusic.qq.com/'
/** Independent safety ceiling for ordinary full-playlist fetches. */
const PLAYLIST_FETCH_HARD_MAX_TRACKS = 100_000
/** Leave headroom beyond one maximum-size playlist so unrelated tracks remain cached. */
const TRACK_REGISTRY_MAX_TRACKS = 16_384

class PlaylistPaginationError extends Error {
  constructor(source: MusicSource, playlistId: string, page: number) {
    super(`Playlist pagination repeated page ${page}: ${source}/${playlistId}`)
    this.name = 'PlaylistPaginationError'
  }
}

function fingerprintPlaylistPage(songs: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(songs)).digest('hex')
}

/** Race a promise against a timeout. Returns null on timeout. */
async function withTimeout<T>(promise: Promise<T>, ms = API_TIMEOUT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// Path to song list in raw (non-formatted) API response per platform
const SEARCH_PATHS: Record<MusicSource, string> = {
  netease: 'result.songs',
  tencent: 'data.song.list',
  kugou: 'data.info',
}

// Path to song list in raw playlist API response per platform
const PLAYLIST_PATHS: Record<MusicSource, string> = {
  netease: 'playlist.tracks', // Not used (Netease uses ncmApi)
  tencent: 'data.cdlist.0.songlist', // JS arrays support string numeric index
  kugou: 'data.info',
}

// ---------------------------------------------------------------------------
// Cache TTL constants
// ---------------------------------------------------------------------------
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

export class PlaylistSearchLimitError extends Error {
  readonly code = 'PLAYLIST_TRACK_LIMIT_EXCEEDED'
  readonly maxTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS

  constructor(readonly actualTracks?: number) {
    super(
      actualTracks === undefined
        ? `歌单超过支持上限 ${LIMITS.PLAYLIST_SEARCH_MAX_TRACKS} 首`
        : `歌单包含 ${actualTracks} 首歌曲，超过支持上限 ${LIMITS.PLAYLIST_SEARCH_MAX_TRACKS} 首`,
    )
    this.name = 'PlaylistSearchLimitError'
  }
}

// ---------------------------------------------------------------------------
// TrackMeta — Track without per-instance fields (id, requestedBy)
// ---------------------------------------------------------------------------
type TrackMeta = Omit<Track, 'id' | 'requestedBy'>

/** Why a stream URL lookup failed (or partially degraded). */
export type StreamUrlFailureReason = 'login_required' | 'vip_or_copyright' | 'upstream_failed' | 'timeout'

export interface StreamUrlResult {
  url: string | null
  reason?: StreamUrlFailureReason
  /** Human-readable detail for logs / optional UI. */
  detail?: string
  usedAnonymousCookie?: boolean
  level?: string
}

/** Map room audio quality to Netease song_url_v1 level candidates (high → low). */
export function neteaseLevelsForBitrate(bitrate: number): string[] {
  if (bitrate >= 999) return ['lossless', 'exhigh', 'standard']
  // 192/320 both map to exhigh first; song_url_v1 has no dedicated 192 tier.
  if (bitrate >= 192) return ['exhigh', 'standard']
  return ['standard']
}

/** QQ 音乐文件类型：前缀 + 扩展名，文件名形如 M800<media_mid>.mp3。 */
interface TencentFileType {
  code: string
  ext: string
}

/**
 * Map room audio quality to QQ Music vkey filename candidates (high → low).
 * The vkey endpoint only grants a tier when the account/IP is allowed; higher
 * tiers usually need a logged-in cookie (e.g. M800 320kbps).
 */
export function tencentFileCandidatesForBitrate(bitrate: number): TencentFileType[] {
  if (bitrate >= 999) {
    return [
      { code: 'F000', ext: '.flac' },
      { code: 'M800', ext: '.mp3' },
      { code: 'C600', ext: '.m4a' },
      { code: 'M500', ext: '.mp3' },
    ]
  }
  if (bitrate >= 320) {
    return [
      { code: 'M800', ext: '.mp3' },
      { code: 'C600', ext: '.m4a' },
      { code: 'M500', ext: '.mp3' },
      { code: 'C400', ext: '.m4a' },
    ]
  }
  if (bitrate >= 192) {
    return [
      { code: 'C600', ext: '.m4a' },
      { code: 'M500', ext: '.mp3' },
      { code: 'C400', ext: '.m4a' },
    ]
  }
  return [
    { code: 'M500', ext: '.mp3' },
    { code: 'C400', ext: '.m4a' },
    { code: 'C200', ext: '.m4a' },
  ]
}

function normalizeStreamUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return url.startsWith('http://') ? url.replace(/^http:\/\//, 'https://') : url
}

function cookieFromNcmResponse(res: { body?: any; cookie?: unknown } | null | undefined): string | null {
  if (!res) return null
  const bodyCookie = res.body?.cookie
  if (typeof bodyCookie === 'string' && bodyCookie.trim()) return bodyCookie.trim()
  if (Array.isArray(bodyCookie) && bodyCookie.length > 0) {
    return bodyCookie.map(String).join('; ')
  }
  const topCookie = res.cookie
  if (typeof topCookie === 'string' && topCookie.trim()) return topCookie.trim()
  if (Array.isArray(topCookie) && topCookie.length > 0) {
    return topCookie.map(String).join('; ')
  }
  return null
}

function classifyNeteaseStreamFailure(
  entry: Record<string, any> | undefined,
  hadUserCookie: boolean,
): StreamUrlFailureReason {
  if (!entry) return 'upstream_failed'
  const fee = Number(entry.fee ?? 0)
  const code = Number(entry.code ?? 0)
  const freeTrial = Boolean(entry.freeTrialInfo) && entry.freeTrialInfo !== 'null'
  // 404 from player/url often means region/account/source restriction rather than a missing track id.
  if (code === 404) return hadUserCookie ? 'vip_or_copyright' : 'login_required'
  if (!hadUserCookie && (fee === 1 || fee === 4 || freeTrial || code === -110)) {
    return fee === 1 || fee === 4 || freeTrial ? 'login_required' : 'vip_or_copyright'
  }
  if (fee === 1 || fee === 4 || code === -110) return 'vip_or_copyright'
  return 'upstream_failed'
}

export class MusicProvider {
  // Shared instances with format(true) — used for url/lyric/cover operations (no cookie)
  private instances = new Map<MusicSource, MetingInstance>()

  // ---------------------------------------------------------------------------
  // 3-Layer Cache Architecture
  // ---------------------------------------------------------------------------

  // Layer 1: Track Registry — single source of truth for all track metadata.
  // Every track that passes through the system (search, playlist) gets registered
  // here. Cross-context enrichment: search provides duration + cover, playlist
  // provides additional tracks. Merge strategy keeps the richest data.
  private trackRegistry = new LRUCache<string, TrackMeta>({
    max: TRACK_REGISTRY_MAX_TRACKS,
    ttl: 2 * HOUR,
  })

  // Layer 2: Reference Indexes — store only sourceId arrays, NOT full Track objects.
  // Memory-efficient: a 2000-track playlist costs ~40KB (IDs) instead of ~1MB (Track[]).
  private searchIndex = new LRUCache<string, { source: MusicSource; ids: string[] }>({
    max: 200,
    ttl: 10 * MINUTE,
  })
  private playlistIndex = new LRUCache<string, { source: MusicSource; ids: string[] }>({
    max: 50,
    ttl: 30 * MINUTE,
  })

  // Layer 3: Resource Caches — scalar values for stream URLs, covers, lyrics.
  private streamUrlCache = new LRUCache<string, string>({ max: 500, ttl: 1 * HOUR })
  private coverCache = new LRUCache<string, string>({ max: 1000, ttl: 24 * HOUR })
  private lyricCache = new LRUCache<
    string,
    { lyric: string; tlyric: string; romalrc: string; yrc: string; wordByWord?: AmllLyricLine[] }
  >({
    max: 500,
    ttl: 24 * HOUR,
  })

  /** Cached Netease guest cookie from register_anonimous (process-local). */
  private neteaseAnonymousCookie: string | null = null
  private neteaseAnonymousCookiePromise: Promise<string | null> | null = null

  /**
   * Playlist visibility can depend on the authenticated account. Keep indexes
   * in separate credential scopes without retaining secrets in cache keys.
   */
  private getPlaylistCacheKey(
    source: MusicSource,
    type: 'playlist' | 'album',
    playlistId: string,
    cookie?: string | null,
  ): string {
    const credentialScope = cookie ? createHash('sha256').update(cookie).digest('hex') : 'anonymous'
    return `${source}:${type}:${playlistId}:auth:${credentialScope}`
  }

  private getInstance(source: MusicSource): MetingInstance {
    let m = this.instances.get(source)
    if (!m) {
      m = new Meting(source)
      m.format(true)
      this.instances.set(source, m)
    }
    return m
  }

  // ---------------------------------------------------------------------------
  // Track Registry helpers
  // ---------------------------------------------------------------------------

  /**
   * Register tracks into the registry, merging with existing data.
   * Merge strategy: keep the richer value for each field (non-empty wins).
   * This enables cross-context enrichment: search provides duration + cover,
   * playlist provides additional tracks, and both benefit from each other.
   */
  private registerTracks(tracks: Track[]): void {
    for (const t of tracks) {
      const key = `${t.source}:${t.sourceId}`
      const existing = this.trackRegistry.get(key)
      const { id: _id, requestedBy: _rb, ...meta } = t
      if (existing) {
        const merged: TrackMeta = {
          ...existing,
          cover: existing.cover || meta.cover,
          duration: existing.duration || meta.duration,
          vip: existing.vip || meta.vip,
          mediaMid: existing.mediaMid || meta.mediaMid,
        }
        this.trackRegistry.set(key, merged)
      } else {
        this.trackRegistry.set(key, meta)
      }
    }
  }

  /**
   * Enrich a track in-place from the registry (fill missing cover, duration, vip).
   * Called before caching playlist tracks so that previously-searched tracks
   * get their duration and cover carried over.
   */
  private enrichFromRegistry(track: Track): void {
    const cached = this.trackRegistry.get(`${track.source}:${track.sourceId}`)
    if (!cached) return
    if (!track.cover && cached.cover) track.cover = cached.cover
    if (!track.duration && cached.duration) track.duration = cached.duration
    if (!track.vip && cached.vip) track.vip = cached.vip
  }

  /**
   * Hydrate sourceId[] back into Track[] from the registry.
   * Returns null if ANY id is missing (registry eviction) — caller should
   * treat this as a cache miss and re-fetch from Meting.
   * Each hydrated Track gets a fresh nanoid for its `id` field.
   */
  private hydrateFromRegistry(source: MusicSource, ids: string[]): Track[] | null {
    const tracks: Track[] = []
    for (const sourceId of ids) {
      const meta = this.trackRegistry.get(`${source}:${sourceId}`)
      if (!meta) return null
      tracks.push({ ...meta, id: nanoid() })
    }
    return tracks
  }

  // ---------------------------------------------------------------------------
  // Public API — Search
  // ---------------------------------------------------------------------------

  /**
   * Search Tencent (QQ 音乐) using the new Desktop API.
   * The legacy Meting API returns empty results, so we use the direct API.
   */
  /**
   * Search Tencent (QQ 音乐). 主路径为新版 Desktop API（明文 musicu.fcg）；
   * 海外 IP 被 500001 风控时依次降级到签名版 musics.fcg 和旧版 Web 搜索接口
   *（client_search_cp，海外 IP 实测可用），与网易云 song_url_v1 → song_url_match 同级 fallback。
   */
  private async searchTencent(keyword: string, limit = 20, page = 1): Promise<Track[]> {
    // Early Exit: empty keyword
    if (!keyword.trim()) return []

    const desktop = await this.searchTencentDesktop(keyword, limit, page)
    if (desktop.length > 0) return desktop

    const signed = await this.searchTencentSigned(keyword, limit, page)
    if (signed.length > 0) return signed

    const legacy = await this.searchTencentLegacy(keyword, limit, page)
    if (legacy.length > 0) return legacy

    logger.warn(`Tencent search exhausted all sources for "${keyword}"`)
    return []
  }

  /** 新版 Desktop 搜索（明文 musicu.fcg）。 */
  private async searchTencentDesktop(keyword: string, limit: number, page: number): Promise<Track[]> {
    try {
      const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const payload = {
        comm: {
          ct: '6',
          cv: '80600',
          tmeAppID: 'qqmusic',
        },
        'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
          module: 'music.search.SearchCgiService',
          method: 'DoSearchForQQMusicDesktop',
          param: {
            num_per_page: limit,
            page_num: page,
            search_type: 0,
            query: keyword,
            grp: 1,
          },
        },
      }

      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://y.qq.com',
            'User-Agent': 'QQ%E9%9F%B3%E4%B9%90/73222',
          },
          body: JSON.stringify(payload),
        }).then((res) => res.json() as Promise<TencentSearchResponse>),
      )

      if (!response) {
        logger.warn(`Tencent search timeout for "${keyword}"`)
        return []
      }

      const result = response['music.search.SearchCgiService.DoSearchForQQMusicDesktop']
      if (result?.code !== 0 || !result?.data?.body?.song?.list) {
        logger.warn(`Tencent search failed: code ${result?.code}`)
        return []
      }

      return this.completeTencentSearch(keyword, this.tencentSearchSongsToTracks(result.data.body.song.list), 'desktop')
    } catch (error) {
      logger.error('Tencent search failed:', error)
      return []
    }
  }

  /** 签名版搜索（musics.fcg，海外 IP 明文接口被风控时仍可发起请求）。 */
  private async searchTencentSigned(keyword: string, limit: number, page: number): Promise<Track[]> {
    try {
      const response = await this.signedTencentRequest({
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          num_per_page: limit,
          page_num: page,
          search_type: 0,
          query: keyword,
          grp: 1,
        },
      })
      const songList = response?.req?.data?.body?.song?.list
      if (!Array.isArray(songList) || songList.length === 0) {
        logger.warn(`Tencent signed search returned empty for "${keyword}"`)
        return []
      }
      return this.completeTencentSearch(keyword, this.tencentSearchSongsToTracks(songList), 'signed')
    } catch (err) {
      logger.error('Tencent signed search failed:', err)
      return []
    }
  }

  /** 旧版 Web 搜索（client_search_cp，海外 IP 实测可用）。 */
  private async searchTencentLegacy(keyword: string, limit: number, page: number): Promise<Track[]> {
    try {
      const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}&aggr=1&lossless=1&cr=1&new_json=1`
      const response = await withTimeout(
        fetch(url, {
          headers: {
            Referer: 'https://y.qq.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          },
        }).then((res) => res.json() as Promise<Record<string, any>>),
      )
      const songList = (response as any)?.data?.song?.list
      if (!Array.isArray(songList) || songList.length === 0) {
        logger.warn(`Tencent legacy search returned empty for "${keyword}"`)
        return []
      }
      return this.completeTencentSearch(keyword, this.tencentSearchSongsToTracks(songList), 'legacy')
    } catch (err) {
      logger.error('Tencent legacy search failed:', err)
      return []
    }
  }

  private completeTencentSearch(keyword: string, tracks: Track[], via: string): Track[] {
    this.registerTracks(tracks)
    logger.info(`Search "${keyword}" on tencent (${via}): ${tracks.length} results`)
    return tracks
  }

  private tencentSearchSongsToTracks(songs: TencentSearchSong[]): Track[] {
    return songs.map((song) => ({
      id: nanoid(),
      source: 'tencent' as const,
      sourceId: song.mid,
      title: song.name || song.title || 'Unknown',
      artist: song.singer?.map((s) => s.name).filter(Boolean) || ['Unknown'],
      album: song.album?.name || song.album?.title || '',
      duration: song.interval || 0, // already in seconds
      cover: song.album?.pmid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid}.jpg` : '',
      urlId: song.mid,
      lyricId: song.mid,
      picId: song.album?.mid || '',
      mediaMid: song.file?.media_mid || '',
      // VIP 判断: pay_month=1 月度会员, pay_down=1 付费下载, pay_play=1 需要 VIP, msgpay>0 VIP 标志
      vip:
        song.pay?.pay_month === 1 ||
        song.pay?.pay_down === 1 ||
        song.pay?.pay_play === 1 ||
        (song.action?.msgpay ?? 0) > 0,
    }))
  }

  /**
   * Search for tracks. Uses format(false) to get raw API data including duration,
   * then batch-resolves cover URLs.
   */

  /**
   * Search for albums. Returns a list of Playlist objects.
   */
  async searchAlbum(
    source: MusicSource,
    keyword: string,
    limit = 20,
    page = 1,
  ): Promise<import('@music-together/shared').Playlist[]> {
    if (!keyword.trim()) return []

    try {
      if (source === 'tencent') {
        const desktop = await this.searchTencentAlbumDesktop(keyword, limit, page)
        if (desktop.length > 0) return desktop

        // 海外 IP 桌面专辑搜索被风控/返回空时，综合搜索（SearchAdaptor.do_search_v2）实测可用
        const general = await this.searchTencentAlbumGeneral(keyword, limit, page)
        if (general.length > 0) return general

        logger.warn(`Tencent album search exhausted all sources for "${keyword}"`)
        return []
      }

      if (source === 'kugou') {
        const url = `http://mobilecdn.kugou.com/api/v3/search/album?api_ver=1&area_code=1&correct=1&pagesize=${limit}&plat=2&tag=1&sver=5&showtype=10&page=${page}&keyword=${encodeURIComponent(keyword)}&version=8990`
        const response = await withTimeout(fetch(url).then((res) => res.json()))

        if (!response || response.errcode !== 0 || !response.data?.info) return []

        return response.data.info.map((album: any) => ({
          id: String(album.albumid),
          name: album.albumname || 'Unknown Album',
          cover: (album.imgurl || '').replace('{size}', '400'),
          trackCount: album.songcount || 0,
          source: 'kugou',
          creator: album.singername || '',
        }))
      }

      if (source === 'netease') {
        const meting = new Meting('netease')
        meting.format(false) // Important: don't format because format expects songs
        const raw = await withTimeout(meting.search(keyword, { limit, page, type: 10 } as any))
        if (!raw) return []

        let data: any
        try {
          data = JSON.parse(raw as string)
        } catch {
          return []
        }

        const albums = data?.result?.albums
        if (!Array.isArray(albums)) return []

        return albums.map((album: any) => ({
          id: String(album.id),
          name: album.name || 'Unknown Album',
          cover: album.picUrl || album.blurPicUrl || '',
          trackCount: album.size || 0,
          source: 'netease',
          creator: album.artist?.name || '',
        }))
      }

      return []
    } catch (err) {
      logger.error(`Search album failed for ${source}:`, err)
      return []
    }
  }

  /**
   * Search for playlists. Returns a list of Playlist objects.
   */
  async searchPlaylist(
    source: MusicSource,
    keyword: string,
    limit = 20,
    page = 1,
  ): Promise<import('@music-together/shared').Playlist[]> {
    if (!keyword.trim()) return []

    try {
      if (source === 'tencent') {
        const desktop = await this.searchTencentPlaylistDesktop(keyword, limit, page)
        if (desktop.length > 0) return desktop

        // 海外 IP 桌面歌单搜索为空，综合搜索的 item_songlist 实测可用
        const general = await this.searchTencentPlaylistGeneral(keyword, limit, page)
        if (general.length > 0) return general

        logger.warn(`Tencent playlist search exhausted all sources for "${keyword}"`)
        return []
      }

      if (source === 'kugou') {
        const url = `http://mobilecdn.kugou.com/api/v3/search/special?api_ver=1&area_code=1&correct=1&pagesize=${limit}&plat=2&tag=1&sver=5&showtype=10&page=${page}&keyword=${encodeURIComponent(keyword)}&version=8990`
        const response = await withTimeout(fetch(url).then((res) => res.json()))

        if (!response || response.errcode !== 0 || !response.data?.info) return []

        return response.data.info.map((playlist: any) => ({
          id: String(playlist.specialid),
          name: playlist.specialname || 'Unknown Playlist',
          cover: (playlist.imgurl || '').replace('{size}', '400'),
          trackCount: playlist.songcount || 0,
          source: 'kugou',
          creator: playlist.nickname || '',
          description: playlist.intro || '',
        }))
      }

      if (source === 'netease') {
        const meting = new Meting('netease')
        meting.format(false) // Important: don't format because format expects songs
        const raw = await withTimeout(meting.search(keyword, { limit, page, type: 1000 } as any))
        if (!raw) return []

        let data: any
        try {
          data = JSON.parse(raw as string)
        } catch {
          return []
        }

        const playlists = data?.result?.playlists
        if (!Array.isArray(playlists)) return []

        return playlists.map((playlist: any) => ({
          id: String(playlist.id),
          name: playlist.name || 'Unknown Playlist',
          cover: playlist.coverImgUrl || playlist.picUrl || '',
          trackCount: playlist.trackCount || 0,
          source: 'netease',
          creator: playlist.creator?.nickname || '',
          description: playlist.description || '',
        }))
      }

      return []
    } catch (err) {
      logger.error(`Search playlist failed for ${source}:`, err)
      return []
    }
  }

  /** 新版 Desktop 专辑搜索（明文 musicu.fcg，search_type=2）。 */
  private async searchTencentAlbumDesktop(
    keyword: string,
    limit: number,
    page: number,
  ): Promise<import('@music-together/shared').Playlist[]> {
    try {
      const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const payload = {
        comm: { ct: '6', cv: '80600', tmeAppID: 'qqmusic' },
        'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
          module: 'music.search.SearchCgiService',
          method: 'DoSearchForQQMusicDesktop',
          param: { num_per_page: limit, page_num: page, search_type: 2, query: keyword, grp: 1 },
        },
      }

      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://y.qq.com',
            'User-Agent': 'QQ%E9%9F%B3%E4%B9%90/73222',
          },
          body: JSON.stringify(payload),
        }).then((res) => res.json()),
      )

      if (!response) return []

      const result = response['music.search.SearchCgiService.DoSearchForQQMusicDesktop']
      if (result?.code !== 0 || !result?.data?.body?.album?.list) {
        logger.warn(`Tencent album search failed (desktop): code ${result?.code}`)
        return []
      }

      return result.data.body.album.list.map((album: any) => ({
        id: String(album.albumMID || album.albumID),
        name: album.albumName || 'Unknown Album',
        cover: album.albumPic || '',
        trackCount: album.song_count || 0,
        source: 'tencent',
        creator: album.singerName || '',
      }))
    } catch (err) {
      logger.error('Tencent album search failed (desktop):', err)
      return []
    }
  }

  /**
   * 综合搜索（music.adaptor.SearchAdaptor / do_search_v2）里的专辑区块。
   * 海外 IP 下桌面专辑搜索为空，但综合搜索的 item_album 实测可正常返回。
   */
  private async searchTencentAlbumGeneral(
    keyword: string,
    limit: number,
    page: number,
  ): Promise<import('@music-together/shared').Playlist[]> {
    const body = await this.searchTencentGeneralSearch(keyword, limit, page)
    const items = body?.item_album?.items
    if (!Array.isArray(items) || items.length === 0) {
      logger.warn(`Tencent album search failed (general): "${keyword}"`)
      return []
    }

    return items.map((item: any) => ({
      id: String(item.albummid || item.id),
      name: item.name || 'Unknown Album',
      cover: item.pic || '',
      trackCount: item.song_num || 0,
      source: 'tencent',
      creator: item.singer_list?.[0]?.name || String(item.singer || '').replace(/<[^>]+>/g, '') || '',
    }))
  }

  /** 综合搜索请求（music.adaptor.SearchAdaptor / do_search_v2），返回响应 body。 */
  private async searchTencentGeneralSearch(
    keyword: string,
    limit: number,
    page: number,
  ): Promise<Record<string, any> | null> {
    try {
      const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const payload = {
        comm: { ct: '6', cv: '80600', tmeAppID: 'qqmusic' },
        'music.adaptor.SearchAdaptor': {
          module: 'music.adaptor.SearchAdaptor',
          method: 'do_search_v2',
          param: {
            searchid: crypto.randomUUID(),
            search_type: 100,
            page_num: limit,
            query: keyword,
            page_id: page,
            highlight: true,
            grp: true,
          },
        },
      }

      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://y.qq.com',
            'User-Agent': 'QQ%E9%9F%B3%E4%B9%90/73222',
          },
          body: JSON.stringify(payload),
        }).then((res) => res.json()),
      )

      return (response as any)?.['music.adaptor.SearchAdaptor']?.data?.body ?? null
    } catch (err) {
      logger.error('Tencent general search failed:', err)
      return null
    }
  }

  /** 综合搜索里的歌单区块（海外 IP 下桌面歌单搜索为空，此区块实测可用）。 */
  private async searchTencentPlaylistGeneral(
    keyword: string,
    limit: number,
    page: number,
  ): Promise<import('@music-together/shared').Playlist[]> {
    const body = await this.searchTencentGeneralSearch(keyword, limit, page)
    const items = body?.item_songlist?.items
    if (!Array.isArray(items) || items.length === 0) {
      logger.warn(`Tencent playlist search failed (general): "${keyword}"`)
      return []
    }

    return items.map((item: any) => ({
      id: String(item.dissid || item.docid),
      name: String(item.dissname || '').replace(/<[^>]+>/g, '') || 'Unknown Playlist',
      cover: item.logo || '',
      trackCount: item.songnum || 0,
      source: 'tencent',
      creator: item.nickname || '',
      description: String(item.description || '').replace(/<[^>]+>/g, '') || '',
    }))
  }

  /** 新版 Desktop 歌单搜索（明文 musicu.fcg，search_type=3）。 */
  private async searchTencentPlaylistDesktop(
    keyword: string,
    limit: number,
    page: number,
  ): Promise<import('@music-together/shared').Playlist[]> {
    try {
      const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const payload = {
        comm: { ct: '6', cv: '80600', tmeAppID: 'qqmusic' },
        'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
          module: 'music.search.SearchCgiService',
          method: 'DoSearchForQQMusicDesktop',
          param: { num_per_page: limit, page_num: page, search_type: 3, query: keyword, grp: 1 },
        },
      }

      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://y.qq.com',
            'User-Agent': 'QQ%E9%9F%B3%E4%B9%90/73222',
          },
          body: JSON.stringify(payload),
        }).then((res) => res.json()),
      )

      if (!response) return []

      const result = response['music.search.SearchCgiService.DoSearchForQQMusicDesktop']
      if (result?.code !== 0 || !result?.data?.body?.songlist?.list) {
        logger.warn(`Tencent playlist search failed (desktop): code ${result?.code}`)
        return []
      }

      return result.data.body.songlist.list.map((playlist: any) => ({
        id: String(playlist.dissid),
        name: playlist.dissname || 'Unknown Playlist',
        cover: playlist.imgurl || '',
        trackCount: playlist.song_count || 0,
        source: 'tencent',
        creator: playlist.creator?.name || '',
        description: playlist.introduction || '',
      }))
    } catch (err) {
      logger.error('Tencent playlist search failed (desktop):', err)
      return []
    }
  }

  async search(source: MusicSource, keyword: string, limit = 20, page = 1): Promise<Track[]> {
    const cacheKey = `${source}:${keyword}:${limit}:${page}`

    // Check reference index
    const indexed = this.searchIndex.get(cacheKey)
    if (indexed) {
      const hydrated = this.hydrateFromRegistry(indexed.source, indexed.ids)
      if (hydrated) {
        logger.info(`Search cache hit: "${keyword}" on ${source} (page ${page})`)
        return hydrated
      }
      // Registry eviction — stale index, fall through to re-fetch
      this.searchIndex.delete(cacheKey)
      logger.info(`Search index stale (registry eviction): "${keyword}" on ${source}`)
    }

    try {
      // QQ 音乐使用新版搜索 API (Meting API 已失效)
      if (source === 'tencent') {
        const tracks = await this.searchTencent(keyword, limit, page)
        // Update search index (cacheKey already defined above)
        this.searchIndex.set(cacheKey, {
          source,
          ids: tracks.map((t) => t.sourceId),
        })
        return tracks
      }

      // Fresh instance without format — gets raw API response with all fields
      const meting = new Meting(source)
      const raw = await withTimeout(meting.search(keyword, { limit, page }))
      if (raw === null) {
        logger.warn(`Search timeout for ${source}: "${keyword}"`)
        return []
      }

      let rawData: MetingJson
      try {
        rawData = JSON.parse(raw) as MetingJson
      } catch (parseError) {
        logger.error(`Search JSON parse failed for ${source}`)
        logger.error(`Parse error:`, parseError)
        logger.error(`Full raw response:`, raw)
        logger.error(`Raw response type:`, typeof raw)
        logger.error(`Raw response length:`, raw?.length)
        return []
      }

      const songs = this.navigatePath(rawData, SEARCH_PATHS[source])
      if (!Array.isArray(songs) || songs.length === 0) return []

      const tracks = songs.map((song: MetingJson) => this.rawToTrack(song, source))

      // Batch resolve cover URLs for tracks that don't already have one
      await this.batchResolveCover(tracks, source)

      // Register into Layer 1 and index into Layer 2
      this.registerTracks(tracks)
      this.searchIndex.set(cacheKey, {
        source,
        ids: tracks.map((t) => t.sourceId),
      })

      logger.info(`Search "${keyword}" on ${source}: ${tracks.length} results`)
      return tracks
    } catch (err) {
      logger.error(`Search failed for ${source}:`, err)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — Stream URL, Lyric, Cover
  // ---------------------------------------------------------------------------

  /**
   * Get stream URL for a track. Optionally inject a cookie for VIP access.
   * Netease uses song_url_v1 (Enhanced API); Kugou uses kugouAuth; others still use Meting.
   */
  async getStreamUrl(source: MusicSource, urlId: string, bitrate = 320, cookie?: string): Promise<string | null> {
    const result = await this.getStreamUrlResult(source, urlId, bitrate, cookie)
    return result.url
  }

  /**
   * Detailed stream URL resolution with failure reason for better client hints.
   */
  async getStreamUrlResult(
    source: MusicSource,
    urlId: string,
    bitrate: number = 320,
    cookie?: string,
  ): Promise<StreamUrlResult> {
    // Skip cache when cookie is provided (VIP URLs are user-specific)
    if (!cookie) {
      const cacheKey = `${source}:${urlId}:${bitrate}`
      const cached = this.streamUrlCache.get(cacheKey)
      if (cached) {
        logger.info(`Stream URL cache hit: ${source}/${urlId}`)
        return { url: cached }
      }
    }

    // Kugou: bypass @meting/core entirely — its kugou provider hardcodes
    // appid=1014 (iOS) but the QR login generates tokens under appid=1005
    // (Android).  Use kugouAuthService.getPlayUrl() with the correct appid.
    if (source === 'kugou') {
      try {
        const result = await kugouAuth.getPlayUrl(urlId, cookie)
        const url = normalizeStreamUrl(result.url || null)
        if (!cookie && url) {
          this.streamUrlCache.set(`${source}:${urlId}:${bitrate}`, url)
        }
        return url
          ? { url }
          : {
              url: null,
              reason: cookie ? 'upstream_failed' : 'login_required',
              detail: cookie ? '酷狗未返回播放链接' : '酷狗播放链接获取失败，可能需要登录',
            }
      } catch (err) {
        logger.error(`Kugou getPlayUrl failed for ${urlId}:`, err)
        return { url: null, reason: 'upstream_failed', detail: '酷狗播放链接请求异常' }
      }
    }

    if (source === 'netease') {
      return this.getNeteaseStreamUrlResult(urlId, bitrate, cookie)
    }

    if (source === 'tencent') {
      return this.getTencentStreamUrlResult(urlId, bitrate, cookie)
    }

    try {
      let meting: MetingInstance
      if (cookie) {
        meting = new Meting(source)
        meting.format(true)
        meting.cookie(cookie)
      } else {
        meting = this.getInstance(source)
      }
      const raw = await withTimeout(meting.url(urlId, bitrate))
      if (raw === null || raw === undefined) {
        logger.warn(`URL fetch timeout for ${source}: ${urlId}`)
        return { url: null, reason: 'timeout', detail: '获取播放链接超时' }
      }
      let data: MetingJson
      try {
        data = JSON.parse(raw as string) as MetingJson
      } catch {
        return { url: null, reason: 'upstream_failed', detail: '播放链接响应无法解析' }
      }
      const url = normalizeStreamUrl((data.url as string) || null)

      if (!cookie && url) {
        this.streamUrlCache.set(`${source}:${urlId}:${bitrate}`, url)
      }

      if (url) return { url }
      return {
        url: null,
        reason: cookie ? 'vip_or_copyright' : 'login_required',
        detail: '平台未返回可用播放链接',
      }
    } catch (err) {
      logger.error(`Get URL failed for ${source}:`, err)
      return { url: null, reason: 'upstream_failed', detail: '获取播放链接失败' }
    }
  }

  private async getNeteaseAnonymousCookie(): Promise<string | null> {
    if (this.neteaseAnonymousCookie) return this.neteaseAnonymousCookie
    if (this.neteaseAnonymousCookiePromise) return this.neteaseAnonymousCookiePromise

    this.neteaseAnonymousCookiePromise = (async () => {
      try {
        const res = await withTimeout((ncmApi as any).register_anonimous({ timestamp: Date.now() }))
        if (!res) {
          logger.warn('Netease register_anonimous timed out')
          return null
        }
        const cookie = cookieFromNcmResponse(res)
        if (cookie) {
          this.neteaseAnonymousCookie = cookie
          logger.info('Netease anonymous cookie registered')
          return cookie
        }
        logger.warn('Netease register_anonimous returned no cookie', {
          code: (res as any)?.body?.code,
        })
        return null
      } catch (err) {
        logger.error('Netease register_anonimous failed', err)
        return null
      } finally {
        this.neteaseAnonymousCookiePromise = null
      }
    })()

    return this.neteaseAnonymousCookiePromise
  }

  private async getNeteaseStreamUrlResult(urlId: string, bitrate: number, cookie?: string): Promise<StreamUrlResult> {
    await ensureNeteaseApiReady()
    const levels = neteaseLevelsForBitrate(bitrate)
    let usedAnonymousCookie = false
    let activeCookie = cookie?.trim() || ''

    if (!activeCookie) {
      const anon = await this.getNeteaseAnonymousCookie()
      if (anon) {
        activeCookie = anon
        usedAnonymousCookie = true
      }
    }

    let lastEntry: Record<string, any> | undefined
    let sawTimeout = false

    for (const level of levels) {
      try {
        const params: Record<string, unknown> = {
          id: urlId,
          level,
          timestamp: Date.now(),
        }
        if (activeCookie) params.cookie = activeCookie

        const res = await withTimeout((ncmApi as any).song_url_v1(params))
        if (!res) {
          sawTimeout = true
          logger.warn(`Netease song_url_v1 timeout: ${urlId} level=${level}`)
          continue
        }

        const body = (res as any).body
        const entry = body?.data?.[0] as Record<string, any> | undefined
        lastEntry = entry
        const url = normalizeStreamUrl(entry?.url ? String(entry.url) : null)
        if (url) {
          if (!cookie) {
            this.streamUrlCache.set(`netease:${urlId}:${bitrate}`, url)
          }
          logger.info(`Netease song_url_v1 ok: ${urlId} level=${level} anon=${usedAnonymousCookie}`)
          return { url, usedAnonymousCookie, level }
        }

        logger.warn(`Netease song_url_v1 empty url: ${urlId} level=${level}`, {
          code: body?.code,
          fee: entry?.fee,
          songCode: entry?.code,
          freeTrial: Boolean(entry?.freeTrialInfo),
        })
      } catch (err) {
        logger.error(`Netease song_url_v1 failed for ${urlId} level=${level}`, err)
      }
    }

    // Production IPs are often blocked by plain song_url_v1 (songCode 404) even for
    // free tracks. Enhanced's song_url_match can still recover a playable URL.
    const matched = await this.getNeteaseMatchedStreamUrl(urlId, activeCookie || undefined)
    if (matched.url) {
      if (!cookie) {
        this.streamUrlCache.set(`netease:${urlId}:${bitrate}`, matched.url)
      }
      logger.info(`Netease song_url_match ok: ${urlId}`)
      return {
        url: matched.url,
        usedAnonymousCookie,
        level: matched.level ?? 'match',
      }
    }

    if (sawTimeout && !lastEntry) {
      return {
        url: null,
        reason: 'timeout',
        detail: '网易云播放链接请求超时',
        usedAnonymousCookie,
      }
    }

    const reason = classifyNeteaseStreamFailure(lastEntry, Boolean(cookie))
    return {
      url: null,
      reason,
      detail:
        reason === 'login_required'
          ? '网易云需要登录后才能播放该歌曲'
          : reason === 'vip_or_copyright'
            ? '网易云版权或 VIP 限制，无法获取播放链接'
            : '网易云未返回可用播放链接',
      usedAnonymousCookie,
    }
  }

  private async getNeteaseMatchedStreamUrl(
    urlId: string,
    cookie?: string,
  ): Promise<{ url: string | null; level?: string }> {
    try {
      const params: Record<string, unknown> = {
        id: urlId,
        timestamp: Date.now(),
      }
      if (cookie) params.cookie = cookie

      // Preferred Enhanced endpoint for unlock/match recovery.
      if (typeof (ncmApi as any).song_url_match === 'function') {
        const res = await withTimeout((ncmApi as any).song_url_match(params))
        const body = (res as any)?.body
        const fromDataField = typeof body?.data === 'string' ? body.data : null
        const fromArray = Array.isArray(body?.data) ? body.data[0]?.url : null
        const url = normalizeStreamUrl(fromDataField || fromArray || body?.url || null)
        if (url) return { url, level: 'match' }
      }

      // Fallback: song_url_v1 with unblock=true (uses Enhanced unblockmusic-utils).
      for (const level of ['exhigh', 'standard'] as const) {
        const res = await withTimeout(
          (ncmApi as any).song_url_v1({
            id: urlId,
            level,
            unblock: 'true',
            timestamp: Date.now(),
            ...(cookie ? { cookie } : {}),
          }),
        )
        const entry = (res as any)?.body?.data?.[0]
        const url = normalizeStreamUrl(entry?.url ? String(entry.url) : null)
        if (url) return { url, level: `match:${level}` }
      }
    } catch (err) {
      logger.error(`Netease song_url_match failed for ${urlId}`, err)
    }
    return { url: null }
  }

  // ---------------------------------------------------------------------------
  // Tencent (QQ 音乐) stream resolution — vkey 新接口
  // ---------------------------------------------------------------------------

  /**
   * QQ Music 已限制旧版 `vkey.GetVkeyServer`（@meting/core 所用）返回空结果。
   * 当前可用的是 musicu.fcg 的 `music.vkey.GetVkey` / `UrlGetVkey`：匿名请求只能解锁
   * 128kbps 档位，更高音质与 VIP 曲目需要登录 cookie。
   */
  private async getTencentStreamUrlResult(urlId: string, bitrate: number, cookie?: string): Promise<StreamUrlResult> {
    const candidates = tencentFileCandidatesForBitrate(bitrate)
    const uin = cookie?.match(/uin=(\d+)/)?.[1] ?? '0'

    // media_mid 与歌曲 mid 常常不同。优先使用 Track 上携带的值（注册表），
    // 回退到歌曲 mid 本身，两者都失败才重新拉取歌曲详情。
    const registryMediaMid = this.trackRegistry.get(`tencent:${urlId}`)?.mediaMid || urlId

    const first = await this.callTencentVkey(urlId, registryMediaMid, candidates, uin, cookie)
    if (first.url) {
      if (!cookie) this.streamUrlCache.set(`tencent:${urlId}:${bitrate}`, first.url)
      return first
    }
    if (first.reason === 'timeout') return first

    // 权限拒绝（104003/104013）与 media_mid 无关，直接分类返回，避免多余请求。
    if (first.upstreamCode === 104003 || first.upstreamCode === 104013) {
      return this.classifyTencentStreamFailure(first.upstreamCode, cookie)
    }

    // media_mid 与歌曲 mid 不一致时，从歌曲详情恢复真实 media_mid 后重试一次。
    const detailMediaMid = await this.fetchTencentMediaMid(urlId)
    if (detailMediaMid && detailMediaMid !== registryMediaMid) {
      const retry = await this.callTencentVkey(urlId, detailMediaMid, candidates, uin, cookie)
      if (retry.url) {
        if (!cookie) this.streamUrlCache.set(`tencent:${urlId}:${bitrate}`, retry.url)
        return retry
      }
      if (retry.reason === 'timeout') return retry
      if (retry.upstreamCode) first.upstreamCode = retry.upstreamCode
    }

    return this.classifyTencentStreamFailure(first.upstreamCode, cookie)
  }

  private classifyTencentStreamFailure(upstreamCode: number | undefined, cookie?: string): StreamUrlResult {
    const denied = upstreamCode === 104003 || upstreamCode === 104013
    return {
      url: null,
      reason: denied ? (cookie ? 'vip_or_copyright' : 'login_required') : 'upstream_failed',
      detail: denied
        ? cookie
          ? 'QQ 音乐版权或 VIP 限制，无法获取播放链接'
          : 'QQ 音乐需要登录后才能播放该歌曲'
        : 'QQ 音乐未返回可用播放链接',
    }
  }

  /** 针对给定 media_mid 调用一次当前 QQ 音乐 vkey 接口。 */
  /**
   * 针对给定 media_mid 依次尝试三个 vkey 通道（与网易云 song_url_v1 → song_url_match
   * 同级的 fallback 策略）：
   * 1. 明文 musicu.fcg `music.vkey.GetVkey`（新版，国内正常）；海外 IP 返回 500001；
   * 2. 签名版 musics.fcg 同一模块（海外 IP 可到达，匿名返回 104003，登录后可解锁）；
   * 3. 旧版 `vkey.GetVkeyServer`（musicu.fcg GET，海外 IP 实测可用）。
   */
  private async callTencentVkey(
    songMid: string,
    mediaMid: string,
    candidates: TencentFileType[],
    uin: string,
    cookie?: string,
  ): Promise<StreamUrlResult & { upstreamCode?: number }> {
    const filenames = candidates.map((c) => `${c.code}${mediaMid}${c.ext}`)
    const songmids = filenames.map(() => songMid)
    const songtypes = filenames.map(() => 0)
    const guid = String(Math.floor(1e9 + Math.random() * 9e9))
    const baseHeaders: Record<string, string> = {
      Referer: 'https://y.qq.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    }
    if (cookie) baseHeaders.Cookie = cookie

    // 1) 明文 musicu.fcg
    const plainPayload = {
      comm: { ct: '6', cv: '80600', tmeAppID: 'qqmusic' },
      req: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: { uin, filename: filenames, guid, songmid: songmids, songtype: songtypes, ctx: 0 },
      },
    }
    let resolved = await this.resolveTencentVkeyAttempt(
      this.safeTencentFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(plainPayload),
      }),
    )
    if (resolved.url) {
      logger.info(`Tencent vkey ok (plain): ${songMid} media=${mediaMid} uin=${uin || 'anon'}`)
      return { url: resolved.url }
    }
    if (resolved.timeout) return { url: null, reason: 'timeout', detail: 'QQ 音乐播放链接请求超时' }
    const firstCode = resolved.upstreamCode

    // 2) 签名版 musics.fcg
    const signedData = {
      comm: { cv: 4747474, ct: 24, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0 },
      req: {
        module: 'music.vkey.GetVkey',
        method: 'UrlGetVkey',
        param: { uin, filename: filenames, guid, songmid: songmids, songtype: songtypes, ctx: 0 },
      },
    }
    const sign = tencentAuth.createTencentSign(signedData)
    resolved = await this.resolveTencentVkeyAttempt(
      this.safeTencentFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(signedData),
      }),
    )
    if (resolved.url) {
      logger.info(`Tencent vkey ok (signed): ${songMid} media=${mediaMid} uin=${uin || 'anon'}`)
      return { url: resolved.url }
    }
    if (resolved.timeout) return { url: null, reason: 'timeout', detail: 'QQ 音乐播放链接请求超时' }
    const secondCode = resolved.upstreamCode || firstCode

    // 3) 旧版 vkey.GetVkeyServer（GET，海外 IP 实测可用）
    const legacyPayload = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: { guid, songmid: songmids, filename: filenames, songtype: songtypes, uin, loginflag: 1, platform: '20' },
      },
    }
    const legacyUrl = `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&platform=yqq.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify(legacyPayload))}`
    resolved = await this.resolveTencentVkeyAttempt(
      this.safeTencentFetch(legacyUrl, { method: 'GET', headers: baseHeaders }),
    )
    if (resolved.url) {
      logger.info(`Tencent vkey ok (legacy): ${songMid} media=${mediaMid} uin=${uin || 'anon'}`)
      return { url: resolved.url }
    }
    if (resolved.timeout) return { url: null, reason: 'timeout', detail: 'QQ 音乐播放链接请求超时' }
    const upstreamCode = resolved.upstreamCode || secondCode

    logger.warn(`Tencent vkey empty across all channels: ${songMid} media=${mediaMid}`, { upstreamCode })
    return { url: null, reason: 'upstream_failed', detail: 'QQ 音乐未返回可用播放链接', upstreamCode }
  }

  /** 统一解析三种 vkey 响应形态（req.data / req_0.data），并吞掉网络异常。 */
  private async resolveTencentVkeyAttempt(
    fetchPromise: Promise<Record<string, any> | null>,
  ): Promise<{ url: string | null; upstreamCode: number; timeout: boolean }> {
    let response: Record<string, any> | null = null
    try {
      response = await fetchPromise
    } catch (err) {
      logger.error('Tencent vkey request failed:', err)
      return { url: null, upstreamCode: 0, timeout: false }
    }
    if (!response) return { url: null, upstreamCode: 0, timeout: true }

    const data = (response as any)?.req?.data ?? (response as any)?.req_0?.data
    const urlinfo: Array<Record<string, any>> = Array.isArray(data?.midurlinfo) ? data.midurlinfo : []
    let upstreamCode = 0
    for (const entry of urlinfo) {
      const result = Number(entry?.result ?? 0)
      if (result !== 0) {
        if (upstreamCode === 0) upstreamCode = result
        continue
      }
      const purl = typeof entry?.purl === 'string' ? entry.purl : ''
      if (purl) {
        const sip =
          Array.isArray(data?.sip) && data.sip.length > 0 ? String(data.sip[0]) : TENCENT_STREAM_FALLBACK_DOMAIN
        const url = normalizeStreamUrl(`${sip}${purl}`)
        if (url) return { url, upstreamCode: 0, timeout: false }
      }
    }
    return { url: null, upstreamCode, timeout: false }
  }

  /** withTimeout 包装的 JSON fetch：超时返回 null。 */
  private safeTencentFetch(url: string, init: RequestInit): Promise<Record<string, any> | null> {
    return withTimeout(fetch(url, init).then((res) => res.json() as Promise<Record<string, any>>))
  }

  /**
   * 通过当前可用的 track-info 接口获取 media_mid。
   * 旧版 UniformRuleClass 已被风控（500003），UniformRuleCtrl 是现行客户端使用的模块。
   */
  /** 签名版 musicu 请求（musics.fcg，zzc 签名）。 */
  private async signedTencentRequest(req: Record<string, unknown>): Promise<Record<string, any> | null> {
    const data = {
      comm: { cv: 4747474, ct: 24, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0 },
      req,
    }
    const sign = tencentAuth.createTencentSign(data)
    const url = `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`
    return withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          Referer: 'https://y.qq.com/',
        },
        body: JSON.stringify(data),
      }).then((res) => res.json() as Promise<Record<string, any>>),
    )
  }

  /** 通过单曲详情接口恢复 media_mid（明文 → 签名 → 旧版逐级降级）。 */
  private async fetchTencentMediaMid(mid: string): Promise<string | null> {
    const track = await this.fetchTencentTrackById(mid)
    return track?.mediaMid || null
  }

  async getLyric(
    source: MusicSource,
    lyricId: string,
  ): Promise<{ lyric: string; tlyric: string; romalrc: string; yrc: string; wordByWord?: AmllLyricLine[] }> {
    const cacheKey = `${source}:${lyricId}`
    const cached = this.lyricCache.get(cacheKey)
    if (cached) {
      logger.info(`Lyric cache hit: ${source}/${lyricId}`)
      return cached
    }

    const empty = { lyric: '', tlyric: '', romalrc: '', yrc: '' as string }

    try {
      let result: { lyric: string; tlyric: string; romalrc: string; yrc: string; wordByWord?: AmllLyricLine[] } = {
        ...empty,
      }

      if (source === 'netease') {
        // 使用 ncmApi.lyric_new 获取包含逐词歌词 (YRC) 的完整响应
        const res = await withTimeout(ncmApi.lyric_new({ id: lyricId }))
        if (!res?.body) {
          logger.warn(`Lyric fetch timeout for ${source}: ${lyricId}`)
          return empty
        }
        const body = res.body
        result = {
          lyric: (body.lrc?.lyric as string) || '',
          tlyric: (body.tlyric?.lyric as string) || '',
          romalrc: ((body.romalrc as Record<string, unknown> | undefined)?.lyric as string) || '',
          yrc: (body.yrc?.lyric as string) || '',
        }
        if (result.yrc) {
          logger.info(`YRC lyric found for netease:${lyricId}`)
        }
      } else if (source === 'kugou') {
        // 酷狗：Meting 获取 LRC + kugou-lrc 获取 KRC 逐字歌词
        const meting = this.getInstance(source)
        const raw = await withTimeout(meting.lyric(lyricId))
        if (raw === null || raw === undefined) {
          logger.warn(`Lyric fetch timeout for ${source}: ${lyricId}`)
          return empty
        }
        try {
          const data = JSON.parse(raw as string) as MetingJson
          result = {
            lyric: (data.lyric as string) || '',
            tlyric: (data.tlyric as string) || '',
            romalrc: '',
            yrc: '',
          }
        } catch {
          return empty
        }
        // 尝试获取 KRC 逐字歌词
        try {
          const krcInfo = await withTimeout(kugouLrcGet({ hash: lyricId, fmt: Format.krc }))
          if (krcInfo?.items?.length) {
            result.wordByWord = krcToAmllLines(krcInfo)
            logger.info(`KRC lyric found for kugou:${lyricId}`)
          }
        } catch {
          /* 静默回退到 LRC */
        }
      } else {
        // QQ 音乐：使用 Meting 默认流程
        const meting = this.getInstance(source)
        const raw = await withTimeout(meting.lyric(lyricId))
        if (raw === null || raw === undefined) {
          logger.warn(`Lyric fetch timeout for ${source}: ${lyricId}`)
          return empty
        }
        try {
          const data = JSON.parse(raw as string) as MetingJson
          result = {
            lyric: (data.lyric as string) || '',
            tlyric: (data.tlyric as string) || '',
            romalrc: '',
            yrc: '',
          }
        } catch {
          return empty
        }
      }

      this.lyricCache.set(cacheKey, result)
      return result
    } catch (err) {
      logger.error(`Get lyric failed for ${source}:`, err)
      return empty
    }
  }

  async getCover(source: MusicSource, picId: string, size = 300): Promise<string> {
    const cacheKey = `${source}:${picId}:${size}`
    const cached = this.coverCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      if (source === 'kugou') {
        const cover = await kugouAuth.getCover(picId)
        if (cover) {
          this.coverCache.set(cacheKey, cover)
        }
        return cover
      }

      const meting = this.getInstance(source)
      const raw = await withTimeout(meting.pic(picId, size))
      if (raw === null || raw === undefined) {
        logger.warn(`Cover fetch timeout for ${source}: ${picId}`)
        return ''
      }
      let data: MetingJson
      try {
        data = JSON.parse(raw as string) as MetingJson
      } catch {
        return ''
      }
      const url = (data.url as string) || ''

      this.coverCache.set(cacheKey, url)
      return url
    } catch (err) {
      logger.error(`Get cover failed for ${source}:`, err)
      return ''
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — Single Track by ID
  // ---------------------------------------------------------------------------

  /**
   * Fetch a single track by its platform sourceId.
   * Checks the track registry first, then falls back to platform-specific APIs.
   * Returns a Track with a fresh nanoid id, or null if not found.
   */
  async getTrackById(source: MusicSource, sourceId: string, cookie?: string | null): Promise<Track | null> {
    // 1. Check registry
    const registryKey = `${source}:${sourceId}`
    const cached = this.trackRegistry.get(registryKey)
    if (cached) {
      logger.info(`Track ID lookup cache hit: ${source}/${sourceId}`)
      return { ...cached, id: nanoid() }
    }

    logger.info(`Track ID lookup cache miss: ${source}/${sourceId}, fetching from platform`)

    try {
      let track: Track | null = null

      switch (source) {
        case 'netease':
          track = await this.fetchNeteaseTrackById(sourceId)
          break
        case 'tencent':
          track = await this.fetchTencentTrackById(sourceId)
          break
        case 'kugou':
          if (isKugouShortCode(sourceId)) {
            logger.info(`Kugou short code detected: ${sourceId}`)
            const resolved = await resolveKugouShortCode(sourceId)
            track = await this.fetchKugouTrackById(resolved.hash)

            const resolvedArtists = resolved.singerName
              .split(/[、,，&]/)
              .map((artist) => artist.trim())
              .filter(Boolean)

            if (!track) {
              track = {
                id: nanoid(),
                title: resolved.songName || 'Unknown',
                artist: resolvedArtists.length > 0 ? resolvedArtists : ['Unknown'],
                album: resolved.albumName || '',
                duration: resolved.duration,
                cover: '',
                source: 'kugou',
                sourceId: resolved.hash,
                urlId: resolved.hash,
                lyricId: resolved.hash,
                picId: resolved.hash,
              }
            } else {
              if ((!track.title || track.title === 'Unknown') && resolved.songName) track.title = resolved.songName
              if (
                (track.artist.length === 0 || track.artist.every((artist) => artist === 'Unknown')) &&
                resolvedArtists.length > 0
              ) {
                track.artist = resolvedArtists
              }
              if (!track.album && resolved.albumName) track.album = resolved.albumName
              if (!track.duration && resolved.duration) track.duration = resolved.duration
            }
            break
          }
          track = await this.fetchKugouTrackById(sourceId)
          break
        default:
          return null
      }

      if (track) {
        this.registerTracks([track])
        // Resolve cover if missing
        if (!track.cover && track.picId) {
          await this.batchResolveCover([track], source)
        }
      }

      return track
    } catch (err) {
      if (err instanceof KugouShortCodeError) throw err
      logger.error(`getTrackById failed for ${source}/${sourceId}:`, err)
      return null
    }
  }

  /**
   * Fetch a single Netease track by song ID via ncmApi.song_detail.
   */
  private async fetchNeteaseTrackById(songId: string): Promise<Track | null> {
    try {
      const res = await withTimeout(ncmApi.song_detail({ ids: songId, timestamp: Date.now() }), 15_000)

      if (res === null) {
        logger.warn(`Netease song_detail timeout: ${songId}`)
        return null
      }

      const songs = res?.body?.songs
      if (!Array.isArray(songs) || songs.length === 0) {
        logger.warn(`Netease song_detail returned empty: ${songId}`, { code: res?.body?.code })
        return null
      }

      return this.rawToTrack(songs[0] as Record<string, unknown>, 'netease')
    } catch (err) {
      logger.error(`Netease song_detail failed: ${songId}`, err)
      return null
    }
  }

  /**
   * Fetch a single Tencent track by song mid via QQ Music Desktop API.
   */
  /**
   * Fetch a single Tencent track by song mid.
   * 主路径为新版 UniformRuleCtrl（明文 musicu.fcg）；海外 IP 被 500001 风控时
   * 依次降级到签名版 musics.fcg 与旧版 fcg_play_single_song（香港 IP 实测可用）。
   */
  private async fetchTencentTrackById(mid: string): Promise<Track | null> {
    const trackData = await this.fetchTencentTrackData(mid)
    if (!trackData) return null
    const track = this.rawToTrack({ musicData: trackData }, 'tencent')
    this.registerTracks([track])
    return track
  }

  private async fetchTencentTrackData(mid: string): Promise<Record<string, any> | null> {
    // 1) 明文 UniformRuleCtrl
    try {
      const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
      const payload = {
        comm: { ct: '6', cv: '80600', tmeAppID: 'qqmusic' },
        'music.trackInfo.UniformRuleCtrl': {
          module: 'music.trackInfo.UniformRuleCtrl',
          method: 'CgiGetTrackInfo',
          param: { mids: [mid], types: [0], ctx: 0, client: 1, modify_stamp: [0] },
        },
      }
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Referer: 'https://y.qq.com',
            'User-Agent': 'QQ%E9%9F%B3%E4%B9%90/73222',
          },
          body: JSON.stringify(payload),
        }).then((res) => res.json() as Promise<Record<string, any>>),
      )
      if (!response) {
        logger.warn(`Tencent track info timeout: ${mid}`)
        return null
      }
      const result = response['music.trackInfo.UniformRuleCtrl']
      if (result?.code === 0 && result?.data?.tracks?.[0]) {
        return result.data.tracks[0] as Record<string, any>
      }
      logger.warn(`Tencent track info failed (plain): ${mid} code ${result?.code}`)
    } catch (err) {
      logger.error(`Tencent track info failed (plain): ${mid}`, err)
    }

    // 2) 签名版 musics.fcg
    try {
      const response = await this.signedTencentRequest({
        module: 'music.trackInfo.UniformRuleCtrl',
        method: 'CgiGetTrackInfo',
        param: { mids: [mid], types: [0], ctx: 0, client: 1, modify_stamp: [0] },
      })
      const track = response?.req?.data?.tracks?.[0]
      if (track) return track as Record<string, any>
      logger.warn(`Tencent track info failed (signed): ${mid}`)
    } catch (err) {
      logger.error(`Tencent track info failed (signed): ${mid}`, err)
    }

    // 3) 旧版 fcg_play_single_song（海外 IP 实测可用）
    try {
      const url = `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(mid)}&platform=yqq&format=json`
      const response = await withTimeout(
        fetch(url, {
          headers: {
            Referer: 'https://y.qq.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          },
        }).then((res) => res.json() as Promise<Record<string, any>>),
      )
      const list = (response as any)?.data
      if (Array.isArray(list) && list[0]) return list[0] as Record<string, any>
      logger.warn(`Tencent track info failed (legacy): ${mid}`)
    } catch (err) {
      logger.error(`Tencent track info failed (legacy): ${mid}`, err)
    }

    return null
  }

  /**
   * Fetch a single Kugou track by hash via the Kugou song info API.
   */
  private async fetchKugouTrackById(hash: string): Promise<Track | null> {
    try {
      const url = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${encodeURIComponent(hash)}`

      const response = await withTimeout(
        fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://www.kugou.com',
          },
        }).then((res) => res.json() as Promise<Record<string, any>>),
      )

      if (!response || response.status !== 1 || !response.data) {
        logger.warn(`Kugou track info failed for hash ${hash}: status ${response?.status}`)
        return null
      }

      return this.rawToTrack(response.data, 'kugou')
    } catch (err) {
      logger.error(`Kugou track info failed: ${hash}`, err)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — Playlist (new: paginated)
  // ---------------------------------------------------------------------------

  /**
   * Ensure a playlist's track IDs are in the registry + index.
   * Does NOT resolve covers (that's deferred to getPlaylistPage).
   * Returns the full sourceId list and total count.
   */
  async fetchFullPlaylist(
    source: MusicSource,
    playlistId: string,
    playlistTotal?: number,
    cookie?: string | null,
    type: 'playlist' | 'album' = 'playlist',
    maxTracks?: number,
  ): Promise<{ ids: string[]; total: number }> {
    const cacheKey = this.getPlaylistCacheKey(source, type, playlistId, cookie)

    // Check reference index — verify registry still has all tracks
    const indexed = this.playlistIndex.get(cacheKey)
    if (indexed) {
      if (maxTracks !== undefined && indexed.ids.length > maxTracks) {
        throw new PlaylistSearchLimitError(indexed.ids.length)
      }
      const allPresent = indexed.ids.every((id) => this.trackRegistry.get(`${indexed.source}:${id}`) !== undefined)
      if (allPresent) {
        logger.info(`Playlist index hit: ${source}/${playlistId} (${indexed.ids.length} tracks)`)
        return { ids: indexed.ids, total: indexed.ids.length }
      }
      this.playlistIndex.delete(cacheKey)
      logger.info(`Playlist index stale (registry eviction): ${source}/${playlistId}`)
    }

    // Netease: use ncmApi.playlist_track_all to bypass Meting's 1000-track limit
    if (source === 'netease') {
      if (type === 'album') {
        return this.fetchNeteaseAlbum(playlistId, cacheKey, maxTracks)
      }
      return this.fetchNeteasePlaylist(playlistId, cacheKey, cookie, maxTracks)
    }

    // Kugou: try native API (works with global_collection_id from user playlists)
    // Falls back to Meting for public playlists / special IDs
    if (source === 'kugou') {
      if (type === 'album') {
        return this.fetchMetingPlaylist(source, playlistId, cacheKey, type, maxTracks)
      }
      const result = await this.fetchKugouPlaylist(playlistId, cacheKey, cookie, maxTracks)
      if (result.total > 0) return result
      logger.info(`Kugou native API returned empty for ${playlistId}, falling back to Meting`)
    }

    // Tencent: use new native API (supports fav & custom lists)
    if (source === 'tencent') {
      if (type === 'album') {
        return this.fetchMetingPlaylist(source, playlistId, cacheKey, type, maxTracks)
      }
      const result = await this.fetchTencentPlaylist(playlistId, cacheKey, cookie, maxTracks)
      if (result.total > 0) return result
      logger.info(`Tencent native API returned empty for ${playlistId}, falling back to Meting`)
    }

    // Fallback: use Meting raw mode
    return this.fetchMetingPlaylist(source, playlistId, cacheKey, type, maxTracks)
  }

  /**
   * Fetch full Netease playlist via ncmApi.playlist_track_all.
   * No 1000-track limit; returns full song data including duration/album/artist.
   */

  /** Fetch Netease album using ncmApi.album */
  private async fetchNeteaseAlbum(
    albumId: string,
    cacheKey: string,
    maxTracks?: number,
  ): Promise<{ ids: string[]; total: number }> {
    try {
      const res = await withTimeout(ncmApi.album({ id: albumId, timestamp: Date.now() }), 30_000)
      if (res === null) {
        logger.warn(`Netease album timeout: ${albumId}`)
        return { ids: [], total: 0 }
      }

      const songs = res?.body?.songs
      if (!Array.isArray(songs) || songs.length === 0) {
        return { ids: [], total: 0 }
      }
      if (maxTracks !== undefined && songs.length > maxTracks) {
        throw new PlaylistSearchLimitError(songs.length)
      }

      const allTracks = songs.map((song: any) => this.rawToTrack(song, 'netease'))

      for (const t of allTracks) this.enrichFromRegistry(t)
      this.registerTracks(allTracks)

      const ids = allTracks.map((t) => t.sourceId)
      this.playlistIndex.set(cacheKey, { source: 'netease', ids })

      logger.info(`Netease album ${albumId}: ${ids.length} tracks`)
      return { ids, total: ids.length }
    } catch (err) {
      if (err instanceof PlaylistSearchLimitError) throw err
      logger.error(`Netease album failed: ${albumId}`, err)
      return { ids: [], total: 0 }
    }
  }

  private async fetchNeteasePlaylist(
    playlistId: string,
    cacheKey: string,
    cookie?: string | null,
    maxTracks?: number,
  ): Promise<{ ids: string[]; total: number }> {
    // Netease /api/v3/song/detail can't handle more than ~1000 IDs per request,
    // so we paginate through playlist_track_all in chunks of 1000.
    const CHUNK_SIZE = 1000
    // Independent of the client-provided total: prevents an abnormal upstream
    // that always returns a full page from causing an unbounded loop.
    const fetchLimit =
      maxTracks === undefined ? PLAYLIST_FETCH_HARD_MAX_TRACKS : Math.min(PLAYLIST_FETCH_HARD_MAX_TRACKS, maxTracks + 1)
    const baseParams = { id: playlistId, timestamp: Date.now(), ...(cookie ? { cookie } : {}) }

    try {
      const allTracks: Track[] = []
      let offset = 0

      while (offset < fetchLimit) {
        const requestLimit = Math.min(CHUNK_SIZE, fetchLimit - offset)
        const res = await withTimeout(ncmApi.playlist_track_all({ ...baseParams, limit: requestLimit, offset }), 60_000)

        if (res === null) {
          logger.warn(`Netease playlist_track_all timeout: ${playlistId} (offset=${offset})`)
          break
        }

        const songs = res?.body?.songs
        if (!Array.isArray(songs) || songs.length === 0) {
          if (offset === 0) {
            logger.warn(`Netease playlist_track_all empty: ${playlistId}`, { code: res?.body?.code })
            return { ids: [], total: 0 }
          }
          break
        }

        const chunk = songs.map((song: Record<string, unknown>) => this.rawToTrack(song, 'netease'))
        allTracks.push(...chunk)
        if (maxTracks !== undefined && allTracks.length > maxTracks) {
          throw new PlaylistSearchLimitError(allTracks.length)
        }

        // If we got fewer than requested, we've reached the end.
        if (songs.length < requestLimit) break
        offset += requestLimit
      }

      if (maxTracks === undefined && offset >= PLAYLIST_FETCH_HARD_MAX_TRACKS) {
        logger.warn(
          `Netease playlist reached hard fetch limit: ${playlistId} (${PLAYLIST_FETCH_HARD_MAX_TRACKS} tracks)`,
        )
      }

      if (allTracks.length === 0) return { ids: [], total: 0 }

      for (const t of allTracks) this.enrichFromRegistry(t)
      this.registerTracks(allTracks)

      const ids = allTracks.map((t) => t.sourceId)
      this.playlistIndex.set(cacheKey, { source: 'netease', ids })

      logger.info(
        `Netease playlist ${playlistId}: ${ids.length} tracks (via ncmApi, ${Math.ceil(ids.length / CHUNK_SIZE)} chunks)`,
      )
      return { ids, total: ids.length }
    } catch (err) {
      if (err instanceof PlaylistSearchLimitError) throw err
      logger.error(`Netease playlist_track_all failed: ${playlistId}`, err)
      return { ids: [], total: 0 }
    }
  }

  /**
   * Fetch kugou playlist via native kugou API (global_collection_id).
   * Supports user playlists that Meting cannot access.
   */
  private async fetchKugouPlaylist(
    playlistId: string,
    cacheKey: string,
    cookie?: string | null,
    maxTracks?: number,
  ): Promise<{ ids: string[]; total: number }> {
    try {
      const PAGE_SIZE = 300
      const allTracks: Track[] = []
      let page = 1
      let totalFromApi = 0
      let fetchedSongCount = 0
      let previousPageFingerprint: string | null = null

      // Paginate until all tracks are fetched
      while (true) {
        const { songs, total } = await kugouAuth.getPlaylistTracks(playlistId, page, PAGE_SIZE, cookie)
        totalFromApi = Math.max(totalFromApi, total)
        if (maxTracks !== undefined && total > maxTracks) {
          throw new PlaylistSearchLimitError(total)
        }

        if (songs.length === 0) break

        const pageFingerprint = fingerprintPlaylistPage(songs)
        if (pageFingerprint === previousPageFingerprint) {
          if (maxTracks !== undefined) throw new PlaylistPaginationError('kugou', playlistId, page)
          logger.warn(`Kugou playlist pagination repeated page ${page}: ${playlistId}`)
          break
        }
        previousPageFingerprint = pageFingerprint

        for (const song of songs) {
          if (maxTracks === undefined && fetchedSongCount >= PLAYLIST_FETCH_HARD_MAX_TRACKS) break

          fetchedSongCount++
          if (maxTracks !== undefined && fetchedSongCount > maxTracks) {
            throw new PlaylistSearchLimitError(fetchedSongCount)
          }

          const track = this.kugouSongToTrack(song)
          if (track) {
            allTracks.push(track)
          } else {
            logger.warn('Kugou playlist: skipping track with no hash', {
              playlistId,
              filename: String(song.filename || song.name || ''),
              hasHash: !!song.hash,
              keys: Object.keys(song).join(','),
            })
          }
        }

        logger.info(
          `Kugou playlist page ${page}: got ${songs.length}, total tracks so far ${allTracks.length}/${totalFromApi}`,
        )

        if (maxTracks === undefined && fetchedSongCount >= PLAYLIST_FETCH_HARD_MAX_TRACKS) {
          logger.warn(
            `Kugou playlist reached hard fetch limit: ${playlistId} (${PLAYLIST_FETCH_HARD_MAX_TRACKS} tracks)`,
          )
          break
        }

        // Upstream total can be absent or stale. Only an empty/short page is a
        // reliable end marker; total is used solely for early limit rejection
        // and progress logging.
        if (songs.length < PAGE_SIZE) break
        page++
      }

      if (allTracks.length === 0) return { ids: [], total: 0 }

      for (const t of allTracks) this.enrichFromRegistry(t)
      this.registerTracks(allTracks)

      const ids = allTracks.map((t) => t.sourceId)
      this.playlistIndex.set(cacheKey, { source: 'kugou', ids })

      logger.info(`Kugou playlist ${playlistId}: ${ids.length} tracks (via native API, ${page} pages)`)
      return { ids, total: ids.length }
    } catch (err) {
      if (err instanceof PlaylistSearchLimitError || err instanceof PlaylistPaginationError) throw err
      logger.error(`Kugou playlist fetch failed: ${playlistId}`, err)
      return { ids: [], total: 0 }
    }
  }

  /**
   * Fetch Tencent playlist via native API.
   * Leverages the new encrypted-uin based getPlaylistTracks implementation.
   */
  private async fetchTencentPlaylist(
    playlistId: string,
    cacheKey: string,
    cookie?: string | null,
    maxTracks?: number,
  ): Promise<{ ids: string[]; total: number }> {
    try {
      const PAGE_SIZE = 100
      const allTracks: Track[] = []
      let page = 1
      let fetchedSongCount = 0
      let previousPageFingerprint: string | null = null

      while (true) {
        const { songs, total } = await tencentAuth.getPlaylistTracks(playlistId, page, PAGE_SIZE, cookie)
        if (maxTracks !== undefined && total > maxTracks) {
          throw new PlaylistSearchLimitError(total)
        }

        if (songs.length === 0) break

        const pageFingerprint = fingerprintPlaylistPage(songs)
        if (pageFingerprint === previousPageFingerprint) {
          if (maxTracks !== undefined) throw new PlaylistPaginationError('tencent', playlistId, page)
          logger.warn(`Tencent playlist pagination repeated page ${page}: ${playlistId}`)
          break
        }
        previousPageFingerprint = pageFingerprint

        for (const song of songs) {
          if (maxTracks === undefined && fetchedSongCount >= PLAYLIST_FETCH_HARD_MAX_TRACKS) break

          fetchedSongCount++
          if (maxTracks !== undefined && fetchedSongCount > maxTracks) {
            throw new PlaylistSearchLimitError(fetchedSongCount)
          }

          const track = this.rawToTrack(song, 'tencent')
          if (track) allTracks.push(track)
        }

        if (maxTracks === undefined && fetchedSongCount >= PLAYLIST_FETCH_HARD_MAX_TRACKS) {
          logger.warn(
            `Tencent playlist reached hard fetch limit: ${playlistId} (${PLAYLIST_FETCH_HARD_MAX_TRACKS} tracks)`,
          )
          break
        }

        // Do not trust a missing or under-reported total to terminate paging.
        if (songs.length < PAGE_SIZE) break
        page++
      }

      if (allTracks.length === 0) return { ids: [], total: 0 }

      for (const t of allTracks) this.enrichFromRegistry(t)
      this.registerTracks(allTracks)

      const ids = allTracks.map((t) => t.sourceId)
      this.playlistIndex.set(cacheKey, { source: 'tencent', ids })

      logger.info(`Tencent playlist ${playlistId}: ${ids.length} tracks (via native API, ${page} pages)`)
      return { ids, total: ids.length }
    } catch (err) {
      if (err instanceof PlaylistSearchLimitError || err instanceof PlaylistPaginationError) throw err
      logger.error(`Tencent playlist fetch failed: ${playlistId}`, err)
      return { ids: [], total: 0 }
    }
  }

  /** Convert a kugou song object from getPlaylistTracks to a Track. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external Kugou API response shape
  private kugouSongToTrack(song: Record<string, unknown>): Track | null {
    // Cast for convenient dynamic property access
    const song_ = song as Record<string, any>
    const hash = song_.hash || song_.audio_info?.hash || ''
    if (!hash) {
      logger.warn('kugouSongToTrack: no hash found', {
        hasHash: !!song_.hash,
        hasAudioInfo: !!song_.audio_info,
        filename: String(song_.filename || song_.name || ''),
        sampleKeys: Object.keys(song).slice(0, 10).join(','),
      })
      return null
    }

    // filename is typically "Artist - Title" or "Artist1、Artist2 - Title"
    const filename = String(song_.filename || song_.name || '')
    const parts = filename.split(' - ')
    const artistStr = parts.length > 1 ? parts[0].trim() : ''
    const artists = artistStr
      ? artistStr
          .split(/[、,，&]/)
          .map((a: string) => a.trim())
          .filter(Boolean)
      : []
    const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : filename

    // Duration: Kugou's native API returns seconds (e.g. 240), but some endpoints
    // return milliseconds (e.g. 240000). Threshold 100000 (~27 hours in seconds)
    // safely distinguishes the two — any value above it is assumed to be milliseconds.
    let duration = Number(song_.duration ?? song_.timelen ?? 0)
    if (duration > 100000) duration = Math.floor(duration / 1000)

    // VIP / privilege
    const privilege = song_.privilege ?? song_.pay_type ?? 0
    const isVip = privilege > 0

    return {
      id: nanoid(),
      source: 'kugou',
      sourceId: hash,
      title,
      artist: artists,
      album: String(song_.album_name || song_.remark || ''),
      duration,
      cover: '',
      lyricId: hash,
      urlId: hash,
      picId: hash,
      vip: isVip,
    }
  }

  /**
   * Fetch playlist via Meting raw mode — used for Tencent/Kugou.
   * Raw mode preserves VIP/pay fields and duration (format mode strips them).
   */
  private async fetchMetingPlaylist(
    source: MusicSource,
    playlistId: string,
    cacheKey: string,
    type: 'playlist' | 'album' = 'playlist',
    maxTracks?: number,
  ): Promise<{ ids: string[]; total: number }> {
    try {
      const meting = new Meting(source)
      const raw = await withTimeout(type === 'album' ? meting.album(playlistId) : meting.playlist(playlistId), 30_000)
      if (raw === null) {
        logger.warn(`Playlist fetch timeout for ${source}: ${playlistId}`)
        return { ids: [], total: 0 }
      }

      let rawData: MetingJson
      try {
        rawData = JSON.parse(raw as string) as MetingJson
      } catch {
        logger.error(`Playlist JSON parse failed for ${source}`, (raw as string)?.substring?.(0, 200))
        return { ids: [], total: 0 }
      }

      // For Tencent album, the path is data.getSongInfo, for Kugou it's data.info
      let path = PLAYLIST_PATHS[source]
      if (type === 'album') {
        if (source === 'tencent') path = 'data.getSongInfo'
        if (source === 'kugou') path = 'data.info'
      }
      const songs = this.navigatePath(rawData, path)
      if (!Array.isArray(songs) || songs.length === 0) return { ids: [], total: 0 }
      if (maxTracks !== undefined && songs.length > maxTracks) {
        throw new PlaylistSearchLimitError(songs.length)
      }

      const tracks = songs.map((song: MetingJson) => this.rawToTrack(song, source))
      for (const t of tracks) this.enrichFromRegistry(t)
      this.registerTracks(tracks)

      const ids = tracks.map((t) => t.sourceId)
      this.playlistIndex.set(cacheKey, { source, ids })

      logger.info(`Playlist ${playlistId} on ${source}: ${tracks.length} tracks (raw mode)`)
      return { ids, total: ids.length }
    } catch (err) {
      if (err instanceof PlaylistSearchLimitError) throw err
      logger.error(`Get playlist failed for ${source}:`, err)
      return { ids: [], total: 0 }
    }
  }

  /**
   * Get a paginated slice of a playlist's tracks.
   * Covers are resolved only for the requested page, not the entire playlist.
   * After resolution, covers are written back to the registry for future reuse.
   */
  async getPlaylistPage(
    source: MusicSource,
    playlistId: string,
    limit: number,
    offset: number,
    playlistTotal?: number,
    cookie?: string | null,
    type: 'playlist' | 'album' = 'playlist',
  ): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    if (playlistTotal !== undefined && playlistTotal > LIMITS.PLAYLIST_SEARCH_MAX_TRACKS) {
      throw new PlaylistSearchLimitError(playlistTotal)
    }

    const { ids, total } = await this.fetchFullPlaylist(
      source,
      playlistId,
      undefined,
      cookie,
      type,
      LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
    )
    if (total === 0) return { tracks: [], total: 0, hasMore: false }

    const pageIds = ids.slice(offset, offset + limit)

    // Hydrate page from registry
    let tracks = this.hydrateFromRegistry(source, pageIds)
    if (!tracks) {
      // Registry eviction between fetchFullPlaylist and hydrate (very rare).
      // Clear index and retry once.
      this.playlistIndex.delete(this.getPlaylistCacheKey(source, type, playlistId, cookie))
      logger.warn(`Playlist page hydration failed, retrying: ${source}/${playlistId}`)
      const retry = await this.fetchFullPlaylist(
        source,
        playlistId,
        undefined,
        cookie,
        type,
        LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      )
      if (retry.total === 0) return { tracks: [], total: 0, hasMore: false }
      const retryPageIds = retry.ids.slice(offset, offset + limit)
      tracks = this.hydrateFromRegistry(source, retryPageIds)
      if (!tracks) {
        logger.error(`Playlist page hydration failed after retry: ${source}/${playlistId}`)
        return { tracks: [], total: retry.total, hasMore: offset + limit < retry.total }
      }
    }

    // Resolve covers for this page only (tracks with cover already set are skipped)
    await this.batchResolveCover(tracks, source)

    // Write newly resolved covers back to registry for cross-page / cross-context reuse
    this.registerTracks(tracks)

    return { tracks, total, hasMore: offset + limit < total }
  }

  /**
   * Search the complete server-side playlist index without sending the full
   * playlist to the client. Only the requested result page is hydrated and has
   * its covers resolved.
   */
  async searchPlaylistTracks(
    source: MusicSource,
    playlistId: string,
    keyword: string,
    page: number = 1,
    limit: number = LIMITS.PLAYLIST_SEARCH_PAGE_SIZE,
    playlistTotal?: number,
    cookie?: string | null,
    type: 'playlist' | 'album' = 'playlist',
  ): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const normalizedKeyword = keyword.trim().toLowerCase()
    if (!normalizedKeyword) return { tracks: [], total: 0, hasMore: false }

    if (playlistTotal !== undefined && playlistTotal > LIMITS.PLAYLIST_SEARCH_MAX_TRACKS) {
      throw new PlaylistSearchLimitError(playlistTotal)
    }

    const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1
    const safeLimit = Number.isFinite(limit)
      ? Math.min(LIMITS.PLAYLIST_SEARCH_PAGE_SIZE, Math.max(1, Math.trunc(limit)))
      : LIMITS.PLAYLIST_SEARCH_PAGE_SIZE

    // `playlistTotal` comes from the client and is only a fast-rejection hint.
    // Never use it to cap fetching, otherwise stale or forged values can make
    // the supposedly full-playlist search silently incomplete.
    const { ids, total: playlistSize } = await this.fetchFullPlaylist(
      source,
      playlistId,
      undefined,
      cookie,
      type,
      LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
    )

    if (playlistSize > LIMITS.PLAYLIST_SEARCH_MAX_TRACKS || ids.length > LIMITS.PLAYLIST_SEARCH_MAX_TRACKS) {
      this.playlistIndex.delete(this.getPlaylistCacheKey(source, type, playlistId, cookie))
      throw new PlaylistSearchLimitError(Math.max(playlistSize, ids.length))
    }

    const matchingIds: string[] = []
    for (const sourceId of ids) {
      const track = this.trackRegistry.get(`${source}:${sourceId}`)
      if (!track) {
        // The full-playlist index and registry must stay in sync. Make the
        // inconsistency visible rather than returning silently incomplete hits.
        throw new Error(`Playlist search index is stale: ${source}/${playlistId}`)
      }

      const titleMatches = track.title.toLowerCase().includes(normalizedKeyword)
      const artistMatches = track.artist.some((artist) => artist.toLowerCase().includes(normalizedKeyword))
      if (titleMatches || artistMatches) matchingIds.push(sourceId)
    }

    const offset = (safePage - 1) * safeLimit
    const pageIds = matchingIds.slice(offset, offset + safeLimit)
    const tracks = this.hydrateFromRegistry(source, pageIds)
    if (!tracks) {
      throw new Error(`Playlist search page hydration failed: ${source}/${playlistId}`)
    }

    await this.batchResolveCover(tracks, source)
    this.registerTracks(tracks)

    return {
      tracks,
      total: matchingIds.length,
      hasMore: offset + safeLimit < matchingIds.length,
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Navigate a dot-separated path in an object */
  private navigatePath(data: MetingJson, path: string): unknown {
    let result: unknown = data
    for (const key of path.split('.')) {
      result = (result as Record<string, unknown>)?.[key]
    }
    return result
  }

  /**
   * Convert raw platform-specific song data to our Track format.
   * Each platform returns different field names, so we need per-platform parsing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- platform API shapes are too dynamic for strict typing
  private rawToTrack(song: Record<string, unknown>, source: MusicSource): Track {
    // Cast to any for convenient dynamic property access on external API responses
    const s = song as Record<string, any>
    switch (source) {
      case 'netease': {
        const neteaseArtists = s.ar?.map((a: Record<string, unknown>) => a.name).filter(Boolean)
        return {
          id: nanoid(),
          title: s.name || 'Unknown',
          artist: neteaseArtists?.length ? neteaseArtists : ['Unknown'],
          album: s.al?.name || '',
          duration: Math.round((s.dt || 0) / 1000), // ms -> seconds
          cover: '', // resolved via pic()
          source,
          sourceId: String(s.id),
          urlId: String(s.id),
          lyricId: String(s.id),
          picId: String(s.al?.pic_str || s.al?.pic || ''),
          // fee: 0=免费, 1=VIP, 4=付费专辑, 8=低音质免费
          vip: s.fee === 1 || s.fee === 4 || s.privilege?.fee === 1 || s.privilege?.fee === 4,
        }
      }

      case 'tencent': {
        // Tencent sometimes wraps data in musicData
        const t = s.musicData || s
        return {
          id: nanoid(),
          title: t.name || 'Unknown',
          artist: (t.singer || []).map((a: Record<string, unknown>) => a.name),
          album: (t.album?.title || t.album?.name || '').trim(),
          duration: t.interval || 0, // already in seconds
          cover: '', // resolved via pic()
          source,
          sourceId: String(t.mid),
          urlId: String(t.mid),
          lyricId: String(t.mid),
          picId: String(t.album?.mid || ''),
          mediaMid: String(t.file?.media_mid || ''),
          // pay.pay_play=1 表示需要 VIP, pay.pay_month=1 表示月度VIP, pay.price_track>0 表示付费单曲
          vip: t.pay?.pay_play === 1 || t.pay?.pay_month === 1 || (t.pay?.price_track ?? 0) > 0,
        }
      }

      case 'kugou': {
        // Kugou encodes artist/title in filename: "Artist - Title"
        const filename = s.filename || s.fileName || ''
        const parts = filename.split(' - ')
        let trackName = filename
        let artists: string[] = []
        if (parts.length >= 2) {
          artists = parts[0]
            .split(/[、,，&]/)
            .map((a: string) => a.trim())
            .filter(Boolean)
          trackName = parts.slice(1).join(' - ')
        }
        return {
          id: nanoid(),
          title: trackName || 'Unknown',
          artist: artists.length > 0 ? artists : ['Unknown'],
          album: s.album_name || '',
          duration: s.duration || 0, // seconds
          cover: '', // resolved via pic() (requires API call)
          source,
          sourceId: String(s.hash),
          urlId: String(s.hash),
          lyricId: String(s.hash),
          picId: String(s.hash),
          // privilege 位掩码: & 8 表示 VIP; pay_type > 0 也表示付费
          vip: ((s.privilege ?? 0) & 8) !== 0 || (s.pay_type ?? 0) > 0,
        }
      }

      default: {
        // Exhaustive check — if a new MusicSource is added, TypeScript will error here
        const _exhaustive: never = source
        throw new Error(`Unsupported music source: ${_exhaustive}`)
      }
    }
  }

  /**
   * Batch-resolve cover URLs for tracks that don't have one.
   * - netease/tencent: pic() is pure URL generation (instant, no API call)
   * - kugou: pic() makes an API call per track (slower)
   *
   * Each pic() call uses a fresh Meting instance to avoid race conditions.
   */
  private async batchResolveCover(tracks: Track[], source: MusicSource): Promise<void> {
    const toResolve = tracks.filter((t) => !t.cover && t.picId)
    if (toResolve.length === 0) return

    // For platforms that need API calls, limit concurrency
    const needsApiCall = source === 'kugou'
    const limit = pLimit(needsApiCall ? 3 : toResolve.length)

    await Promise.allSettled(
      toResolve.map((track) =>
        limit(async () => {
          // Check cover cache first
          const cacheKey = `${source}:${track.picId!}:300`
          const cached = this.coverCache.get(cacheKey)
          if (cached !== undefined) {
            track.cover = cached
            return
          }

          try {
            if (source === 'kugou') {
              const url = await kugouAuth.getCover(track.picId!)
              if (url) {
                track.cover = url
                this.coverCache.set(cacheKey, url)
              }
              return
            }

            // Fresh instance per call to avoid shared state race conditions
            const instance = new Meting(source)
            const raw = await instance.pic(track.picId!, 300)
            const data = JSON.parse(raw)
            if (data.url) {
              track.cover = data.url
              this.coverCache.set(cacheKey, data.url)
            }
          } catch {
            // Leave cover empty — frontend shows placeholder
          }
        }),
      ),
    )
  }
}

export const musicProvider = new MusicProvider()
