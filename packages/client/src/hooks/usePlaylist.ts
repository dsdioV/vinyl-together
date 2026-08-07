import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EVENTS, LIMITS, type MusicSource, type Playlist, type Track } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { SERVER_URL } from '@/lib/config'
import { trackLookupFailure, type TrackLookupResult } from '@/lib/trackLookup'
import { getPlaylistLoadError, PLAYLIST_NETWORK_ERROR } from '@/lib/playlistLoad'
import { toQueueTrackInput } from '@/lib/utils'
import { emitInChunks } from '@/lib/batchQueueAdd'

export { parsePlaylistInput } from '@/lib/musicInput'

const PAGE_SIZE = 1000

type PlaylistType = 'playlist' | 'album'

interface PlaylistSearchResponse {
  tracks?: Track[]
  total?: number
  page?: number
  hasMore?: boolean
  error?: string
}

interface PlaylistPageResponse {
  tracks?: Track[]
  total?: number
  hasMore?: boolean
  code?: unknown
  error?: unknown
}

/** Build the playlist API URL with all query parameters */
function buildPlaylistUrl(
  source: MusicSource,
  id: string,
  limit: number,
  offset: number,
  options?: { total?: number; roomId?: string; type?: PlaylistType },
): string {
  const params = new URLSearchParams({
    source,
    id,
    limit: String(limit),
    offset: String(offset),
  })
  if (options?.total) params.set('total', String(options.total))
  if (options?.roomId) params.set('roomId', options.roomId)
  if (options?.type) params.set('type', options.type)
  return `${SERVER_URL}/api/music/playlist?${params.toString()}`
}

/** Build the server-side full-playlist search URL. */
function buildPlaylistSearchUrl(
  source: MusicSource,
  id: string,
  keyword: string,
  page: number,
  options?: { total?: number; roomId?: string; type?: PlaylistType },
): string {
  const params = new URLSearchParams({
    source,
    id,
    keyword,
    page: String(page),
    limit: String(LIMITS.PLAYLIST_SEARCH_PAGE_SIZE),
  })
  if (options?.total) params.set('total', String(options.total))
  if (options?.roomId) params.set('roomId', options.roomId)
  if (options?.type) params.set('type', options.type)
  return `${SERVER_URL}/api/music/playlist/search?${params.toString()}`
}

export function usePlaylist() {
  const { socket } = useSocketContext()
  const [myPlaylists, setMyPlaylists] = useState<Record<MusicSource, Playlist[]>>({
    netease: [],
    tencent: [],
    kugou: [],
    bilibili: [],
  })
  const [playlistsLoading, setPlaylistsLoading] = useState<Record<MusicSource, boolean>>({
    netease: false,
    tencent: false,
    kugou: false,
    bilibili: false,
  })

  // Paginated playlist tracks state
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([])
  const [playlistTotal, setPlaylistTotal] = useState(0)
  const [hasMoreTracks, setHasMoreTracks] = useState(false)
  const [tracksLoading, setTracksLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [playlistError, setPlaylistError] = useState<string | null>(null)

  // Server-side full-playlist search state. This is kept separate from the
  // infinitely-loaded browsing list so clearing a keyword restores it instantly.
  const [playlistSearchTracks, setPlaylistSearchTracks] = useState<Track[]>([])
  const [playlistSearchTotal, setPlaylistSearchTotal] = useState(0)
  const [playlistSearchPage, setPlaylistSearchPage] = useState(1)
  const [playlistSearchHasMore, setPlaylistSearchHasMore] = useState(false)
  const [playlistSearchLoading, setPlaylistSearchLoading] = useState(false)
  const [playlistSearchError, setPlaylistSearchError] = useState<string | null>(null)

  // Track current playlist context to prevent stale responses
  const currentPlaylistRef = useRef<{ source: MusicSource; id: string; type?: PlaylistType } | null>(null)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const playlistBrowseAbortRef = useRef<AbortController | null>(null)
  const playlistBrowseRequestIdRef = useRef(0)
  const playlistSearchAbortRef = useRef<AbortController | null>(null)
  const playlistSearchRequestIdRef = useRef(0)

  const clearPlaylistSearch = useCallback(() => {
    playlistSearchAbortRef.current?.abort()
    playlistSearchAbortRef.current = null
    playlistSearchRequestIdRef.current += 1
    setPlaylistSearchTracks([])
    setPlaylistSearchTotal(0)
    setPlaylistSearchPage(1)
    setPlaylistSearchHasMore(false)
    setPlaylistSearchLoading(false)
    setPlaylistSearchError(null)
  }, [])

  useEffect(() => {
    return () => {
      playlistBrowseAbortRef.current?.abort()
      playlistSearchAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const onMyList = (data: { platform: MusicSource; playlists: Playlist[] }) => {
      setMyPlaylists((prev) => ({ ...prev, [data.platform]: data.playlists }))
      setPlaylistsLoading((prev) => ({ ...prev, [data.platform]: false }))
    }

    socket.on(EVENTS.PLAYLIST_MY_LIST, onMyList)
    return () => {
      socket.off(EVENTS.PLAYLIST_MY_LIST, onMyList)
    }
  }, [socket])

  const fetchMyPlaylists = useCallback(
    (platform: MusicSource) => {
      setPlaylistsLoading((prev) => ({ ...prev, [platform]: true }))
      socket.emit(EVENTS.PLAYLIST_GET_MY, { platform })
    },
    [socket],
  )

  /**
   * Fetch the first page of a playlist's tracks.
   * Resets all track state immediately to prevent stale data from flashing.
   */
  const fetchPlaylistTracks = useCallback(
    async (
      source: MusicSource,
      playlistId: string,
      trackCount?: number,
      type: PlaylistType = 'playlist',
    ): Promise<Track[]> => {
      // Reset state immediately — prevents flashing old data when switching playlists
      clearPlaylistSearch()
      playlistBrowseAbortRef.current?.abort()
      const controller = new AbortController()
      playlistBrowseAbortRef.current = controller
      const requestId = ++playlistBrowseRequestIdRef.current
      setPlaylistTracks([])
      setPlaylistTotal(0)
      setHasMoreTracks(false)
      setTracksLoading(true)
      setLoadingMore(false)
      setPlaylistError(null)
      loadingMoreRef.current = false

      // Track current context for stale response detection
      currentPlaylistRef.current = { source, id: playlistId, type }
      offsetRef.current = 0

      try {
        const url = buildPlaylistUrl(source, playlistId, PAGE_SIZE, 0, {
          total: trackCount,
          roomId: useRoomStore.getState().room?.id,
          type,
        })
        const res = await fetch(url, { signal: controller.signal, credentials: 'include' })
        const data = (await res.json().catch(() => null)) as PlaylistPageResponse | null

        // Stale response guard
        const ctx = currentPlaylistRef.current
        if (
          playlistBrowseRequestIdRef.current !== requestId ||
          !ctx ||
          ctx.source !== source ||
          ctx.id !== playlistId ||
          ctx.type !== type
        )
          return []

        if (!res.ok) {
          setPlaylistError(getPlaylistLoadError(res.status, data))
          return []
        }

        const tracks: Track[] = data?.tracks ?? []
        const total: number = data?.total ?? tracks.length

        setPlaylistTracks(tracks)
        setPlaylistTotal(total)
        setHasMoreTracks(data?.hasMore ?? false)
        setPlaylistError(null)
        offsetRef.current = tracks.length
        return tracks
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return []
        // Only update state if this is still the active playlist
        const ctx = currentPlaylistRef.current
        if (
          playlistBrowseRequestIdRef.current === requestId &&
          ctx &&
          ctx.source === source &&
          ctx.id === playlistId &&
          ctx.type === type
        ) {
          setPlaylistError(PLAYLIST_NETWORK_ERROR)
        }
        return []
      } finally {
        if (playlistBrowseRequestIdRef.current === requestId) setTracksLoading(false)
      }
    },
    [clearPlaylistSearch],
  )

  /**
   * Load the next page of tracks for the current playlist.
   * Uses a ref for synchronous dedup — prevents duplicate requests from fast scrolling
   * even before React batches the state update.
   */
  const loadMoreTracks = useCallback(async () => {
    const ctx = currentPlaylistRef.current
    if (!ctx || loadingMoreRef.current || !hasMoreTracks) return
    const requestId = playlistBrowseRequestIdRef.current
    const signal = playlistBrowseAbortRef.current?.signal

    loadingMoreRef.current = true
    setLoadingMore(true)

    try {
      const offset = offsetRef.current
      const url = buildPlaylistUrl(ctx.source, ctx.id, PAGE_SIZE, offset, {
        total: playlistTotal,
        roomId: useRoomStore.getState().room?.id,
        type: ctx.type,
      })
      const res = await fetch(url, { signal, credentials: 'include' })
      const data = (await res.json().catch(() => null)) as PlaylistPageResponse | null

      // Stale response guard — context might have changed while we were fetching
      const currentCtx = currentPlaylistRef.current
      if (
        playlistBrowseRequestIdRef.current !== requestId ||
        !currentCtx ||
        currentCtx.source !== ctx.source ||
        currentCtx.id !== ctx.id ||
        currentCtx.type !== ctx.type
      )
        return

      if (!res.ok) {
        setPlaylistError(getPlaylistLoadError(res.status, data))
        setHasMoreTracks(false)
        return
      }

      const newTracks: Track[] = data?.tracks ?? []

      setPlaylistTracks((prev) => [...prev, ...newTracks])
      setHasMoreTracks(data?.hasMore ?? false)
      setPlaylistError(null)
      offsetRef.current = offset + newTracks.length
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      if (playlistBrowseRequestIdRef.current === requestId) {
        setPlaylistError(PLAYLIST_NETWORK_ERROR)
        setHasMoreTracks(false)
      }
    } finally {
      if (playlistBrowseRequestIdRef.current === requestId) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [hasMoreTracks, playlistTotal])

  /**
   * Search the complete remote playlist without downloading the remaining
   * browsing pages into the browser. Each request replaces the previous page.
   */
  const searchPlaylistTracks = useCallback(
    async (
      source: MusicSource,
      playlistId: string,
      keyword: string,
      page = 1,
      trackCount?: number,
      type: PlaylistType = 'playlist',
    ): Promise<void> => {
      const trimmedKeyword = keyword.trim()
      if (!trimmedKeyword) {
        clearPlaylistSearch()
        return
      }

      playlistSearchAbortRef.current?.abort()
      const controller = new AbortController()
      playlistSearchAbortRef.current = controller
      const requestId = ++playlistSearchRequestIdRef.current

      // Clear synchronously at request start so pages/keywords never mix.
      setPlaylistSearchTracks([])
      setPlaylistSearchTotal(0)
      setPlaylistSearchPage(page)
      setPlaylistSearchHasMore(false)
      setPlaylistSearchLoading(true)
      setPlaylistSearchError(null)

      try {
        const url = buildPlaylistSearchUrl(source, playlistId, trimmedKeyword, page, {
          total: trackCount,
          roomId: useRoomStore.getState().room?.id,
          type,
        })
        const res = await fetch(url, { signal: controller.signal, credentials: 'include' })
        const data = (await res.json().catch(() => null)) as PlaylistSearchResponse | null
        if (!res.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`)
        }

        if (playlistSearchRequestIdRef.current !== requestId) return

        const tracks = data?.tracks ?? []
        setPlaylistSearchTracks(tracks)
        setPlaylistSearchTotal(data?.total ?? tracks.length)
        setPlaylistSearchPage(data?.page ?? page)
        setPlaylistSearchHasMore(data?.hasMore ?? tracks.length >= LIMITS.PLAYLIST_SEARCH_PAGE_SIZE)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        if (playlistSearchRequestIdRef.current !== requestId) return
        setPlaylistSearchTracks([])
        setPlaylistSearchTotal(0)
        setPlaylistSearchHasMore(false)
        setPlaylistSearchError(error instanceof Error ? error.message : '搜索失败，请稍后重试')
      } finally {
        if (playlistSearchRequestIdRef.current === requestId) {
          setPlaylistSearchLoading(false)
        }
      }
    },
    [clearPlaylistSearch],
  )

  const addTrackToQueue = useCallback(
    (track: Track) => {
      socket.emit(EVENTS.QUEUE_ADD, { track: toQueueTrackInput(track) })
    },
    [socket],
  )

  const insertTrackAfterCurrent = useCallback(
    (track: Track) => {
      socket.emit(EVENTS.QUEUE_INSERT_AFTER_CURRENT, { track: toQueueTrackInput(track) })
    },
    [socket],
  )

  /**
   * Fetch a single track by its platform ID.
   * Uses the /api/music/track endpoint.
   */
  const fetchTrackById = useCallback(async (source: MusicSource, trackId: string): Promise<TrackLookupResult> => {
    try {
      const params = new URLSearchParams({ source, id: trackId })
      const roomId = useRoomStore.getState().room?.id
      if (roomId) params.set('roomId', roomId)
      const res = await fetch(`${SERVER_URL}/api/music/track?${params.toString()}`, {
        credentials: 'include',
      })
      let data: { track?: Track; code?: unknown; error?: unknown } | null = null
      try {
        data = (await res.json()) as { track?: Track; code?: unknown; error?: unknown }
      } catch {
        // Fall through to a status-specific, safe message.
      }
      if (!res.ok) return trackLookupFailure(res.status, data)
      if (!data?.track) return trackLookupFailure(502, null)
      return { ok: true, track: data.track }
    } catch {
      return { ok: false, code: 'NETWORK_ERROR', message: '无法连接服务器，请稍后重试' }
    }
  }, [])

  const addBatchToQueue = useCallback(
    (tracks: Track[], playlistName?: string) => {
      if (tracks.length === 0) return
      void emitInChunks(tracks, (chunk, index) => {
        socket.emit(EVENTS.QUEUE_ADD_BATCH, {
          tracks: chunk.map(toQueueTrackInput),
          ...(index === 0 && playlistName ? { playlistName } : {}),
        })
      })
    },
    [socket],
  )

  const addBatchToDefaultQueue = useCallback(
    (tracks: Track[]) => {
      const defaultQueueSize = useRoomStore.getState().room?.defaultQueue.length ?? 0
      const remainingCapacity = Math.max(0, LIMITS.DEFAULT_QUEUE_MAX_SIZE - defaultQueueSize)
      const tracksToAdd = tracks.slice(0, remainingCapacity)
      if (tracksToAdd.length === 0) {
        toast.info('默认播放列表已满')
        return
      }
      void emitInChunks(tracksToAdd, (chunk) => {
        socket.emit(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: chunk.map(toQueueTrackInput) })
      })
      toast.success(`开始添加 ${tracksToAdd.length} 首歌到默认播放列表`)
    },
    [socket],
  )

  return {
    myPlaylists,
    playlistsLoading,
    playlistTracks,
    playlistTotal,
    hasMoreTracks,
    tracksLoading,
    loadingMore,
    playlistError,
    playlistSearchTracks,
    playlistSearchTotal,
    playlistSearchPage,
    playlistSearchHasMore,
    playlistSearchLoading,
    playlistSearchError,
    fetchMyPlaylists,
    fetchPlaylistTracks,
    loadMoreTracks,
    searchPlaylistTracks,
    clearPlaylistSearch,
    addTrackToQueue,
    insertTrackAfterCurrent,
    addBatchToQueue,
    addBatchToDefaultQueue,
    fetchTrackById,
  }
}
