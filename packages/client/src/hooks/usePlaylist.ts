import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EVENTS, LIMITS, type MusicSource, type Playlist, type Track } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { SERVER_URL } from '@/lib/config'
import { trackLookupFailure, type TrackLookupResult } from '@/lib/trackLookup'

export { parsePlaylistInput } from '@/lib/musicInput'

const PAGE_SIZE = 1000

/** Build the playlist API URL with all query parameters */
function buildPlaylistUrl(
  source: MusicSource,
  id: string,
  limit: number,
  offset: number,
  options?: { total?: number; roomId?: string; type?: 'playlist' | 'album' },
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

export function usePlaylist() {
  const { socket } = useSocketContext()
  const [myPlaylists, setMyPlaylists] = useState<Record<MusicSource, Playlist[]>>({
    netease: [],
    tencent: [],
    kugou: [],
  })
  const [playlistsLoading, setPlaylistsLoading] = useState<Record<MusicSource, boolean>>({
    netease: false,
    tencent: false,
    kugou: false,
  })

  // Paginated playlist tracks state
  const [playlistTracks, setPlaylistTracks] = useState<Track[]>([])
  const [playlistTotal, setPlaylistTotal] = useState(0)
  const [hasMoreTracks, setHasMoreTracks] = useState(false)
  const [tracksLoading, setTracksLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Track current playlist context to prevent stale responses
  const currentPlaylistRef = useRef<{ source: MusicSource; id: string; type?: 'playlist' | 'album' } | null>(null)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)

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
    async (source: MusicSource, playlistId: string, trackCount?: number, type: 'playlist' | 'album' = 'playlist'): Promise<Track[]> => {
      // Reset state immediately — prevents flashing old data when switching playlists
      setPlaylistTracks([])
      setPlaylistTotal(0)
      setHasMoreTracks(false)
      setTracksLoading(true)
      setLoadingMore(false)
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
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) {
          setTracksLoading(false)
          return []
        }

        // Stale response guard
        const ctx = currentPlaylistRef.current
        if (!ctx || ctx.source !== source || ctx.id !== playlistId) return []

        const data = await res.json()
        const tracks: Track[] = data.tracks ?? []
        const total: number = data.total ?? tracks.length

        setPlaylistTracks(tracks)
        setPlaylistTotal(total)
        setHasMoreTracks(data.hasMore ?? false)
        offsetRef.current = tracks.length
        setTracksLoading(false)
        return tracks
      } catch {
        // Only update state if this is still the active playlist
        const ctx = currentPlaylistRef.current
        if (ctx && ctx.source === source && ctx.id === playlistId) {
          setTracksLoading(false)
        }
        return []
      }
    },
    [],
  )

  /**
   * Load the next page of tracks for the current playlist.
   * Uses a ref for synchronous dedup — prevents duplicate requests from fast scrolling
   * even before React batches the state update.
   */
  const loadMoreTracks = useCallback(async () => {
    const ctx = currentPlaylistRef.current
    if (!ctx || loadingMoreRef.current || !hasMoreTracks) return

    loadingMoreRef.current = true
    setLoadingMore(true)

    try {
      const offset = offsetRef.current
      const url = buildPlaylistUrl(ctx.source, ctx.id, PAGE_SIZE, offset, {
        total: playlistTotal,
        roomId: useRoomStore.getState().room?.id,
        type: ctx.type,
      })
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) return

      // Stale response guard — context might have changed while we were fetching
      const currentCtx = currentPlaylistRef.current
      if (!currentCtx || currentCtx.source !== ctx.source || currentCtx.id !== ctx.id) return

      const data = await res.json()
      const newTracks: Track[] = data.tracks ?? []

      setPlaylistTracks((prev) => [...prev, ...newTracks])
      setHasMoreTracks(data.hasMore ?? false)
      offsetRef.current = offset + newTracks.length
    } catch {
      // Silently fail — user can scroll again to retry
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [hasMoreTracks, playlistTotal])

  const addTrackToQueue = useCallback(
    (track: Track) => {
      socket.emit(EVENTS.QUEUE_ADD, { track })
    },
    [socket],
  )

  const insertTrackAfterCurrent = useCallback(
    (track: Track) => {
      socket.emit(EVENTS.QUEUE_INSERT_AFTER_CURRENT, { track })
    },
    [socket],
  )

  /**
   * Fetch a single track by its platform ID.
   * Uses the /api/music/track endpoint.
   */
  const fetchTrackById = useCallback(
    async (source: MusicSource, trackId: string): Promise<TrackLookupResult> => {
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
    },
    [],
  )

  const addBatchToQueue = useCallback(
    (tracks: Track[], playlistName?: string) => {
      if (tracks.length === 0) return
      socket.emit(EVENTS.QUEUE_ADD_BATCH, { tracks, playlistName })
    },
    [socket],
  )

  const addBatchToDefaultQueue = useCallback(
    (tracks: Track[], _playlistName?: string) => {
      const defaultQueueSize = useRoomStore.getState().room?.defaultQueue.length ?? 0
      const remainingCapacity = Math.max(0, LIMITS.DEFAULT_QUEUE_MAX_SIZE - defaultQueueSize)
      const tracksToAdd = tracks.slice(0, remainingCapacity)
      if (tracksToAdd.length === 0) {
        toast.info('默认播放列表已满')
        return
      }
      socket.emit(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: tracksToAdd })
      toast.success(`已添加 ${tracksToAdd.length} 首歌到默认播放列表`)
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
    fetchMyPlaylists,
    fetchPlaylistTracks,
    loadMoreTracks,
    addTrackToQueue,
    insertTrackAfterCurrent,
    addBatchToQueue,
    addBatchToDefaultQueue,
    fetchTrackById,
  }
}
