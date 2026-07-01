import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EVENTS, LIMITS, type MusicSource, type Playlist, type Track } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { SERVER_URL } from '@/lib/config'

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

/**
 * Extract a playlist ID from a URL or raw ID string.
 * Supports common URL formats for netease, tencent, and kugou.
 */
export function parsePlaylistInput(input: string, source: MusicSource): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // If it looks like a plain numeric/alphanumeric ID, return as-is
  if (/^[\w-]+$/.test(trimmed)) return trimmed

  try {
    const url = new URL(trimmed)

    switch (source) {
      case 'netease': {
        // https://music.163.com/playlist?id=12345
        // https://music.163.com/#/playlist?id=12345
        const idParam = url.searchParams.get('id')
        if (idParam) return idParam
        const hashMatch = url.hash.match(/[?&]id=(\d+)/)
        if (hashMatch) return hashMatch[1]
        const pathMatch = url.pathname.match(/\/playlist\/(\d+)/)
        if (pathMatch) return pathMatch[1]
        break
      }
      case 'tencent': {
        // https://y.qq.com/n/ryqq/playlist/12345.html
        const qqMatch = url.pathname.match(/\/playlist\/(\d+)/)
        if (qqMatch) return qqMatch[1]
        break
      }
      case 'kugou': {
        // Track URL: https://www.kugou.com/song/#hash=BF7F3BC4... or #6h5o4sc6
        if (url.hash) {
          let hashVal = url.hash.replace(/^#/, '').split(/[?&]/)[0].trim()
          // Strip "hash=" prefix if present (Kugou's 32-char audio hash format)
          if (hashVal.startsWith('hash=')) hashVal = hashVal.slice(5)
          if (hashVal && hashVal.length >= 4) return hashVal
        }

        // Songlist URL: https://www.kugou.com/songlist/gcid_3zwlkkpdz1jz0f2/
        const slMatch = url.pathname.match(/\/songlist\/(.+)/)
        if (slMatch) {
          const id = slMatch[1].replace(/\/+$/, '')
          if (id) return id
        }

        // Special/album URL: https://www.kugou.com/yy/special/single/12345.html
        const spMatch = url.pathname.match(/\/special\/(?:single\/)?(\d+)/)
        if (spMatch) return spMatch[1]

        // Fallback: any longer numeric ID in path
        const kgMatch = url.pathname.match(/(\d{4,})/)
        if (kgMatch) return kgMatch[1]
        break
      }
    }
  } catch {
    // Not a URL, try to extract numbers
    const numMatch = trimmed.match(/(\d{4,})/)
    if (numMatch) return numMatch[1]
  }

  return null
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
    async (source: MusicSource, trackId: string): Promise<Track | null> => {
      try {
        const params = new URLSearchParams({ source, id: trackId })
        const roomId = useRoomStore.getState().room?.id
        if (roomId) params.set('roomId', roomId)
        const res = await fetch(`${SERVER_URL}/api/music/track?${params.toString()}`, {
          credentials: 'include',
        })
        if (!res.ok) return null
        const data = await res.json()
        return data.track ?? null
      } catch {
        return null
      }
    },
    [],
  )

  const addBatchToQueue = useCallback(
    (tracks: Track[], playlistName?: string) => {
      // Chunk large batch additions into QUEUE_BATCH_MAX_SIZE groups
      // so long playlists can be added without hitting the schema limit
      const batchSize = LIMITS.QUEUE_BATCH_MAX_SIZE
      for (let i = 0; i < tracks.length; i += batchSize) {
        const chunk = tracks.slice(i, i + batchSize)
        socket.emit(EVENTS.QUEUE_ADD_BATCH, {
          tracks: chunk,
          playlistName: i === 0 ? playlistName : `${playlistName ?? ''} (续 ${Math.floor(i / batchSize) + 1})`,
        })
      }
    },
    [socket],
  )

  const addBatchToDefaultQueue = useCallback(
    (tracks: Track[], _playlistName?: string) => {
      if (tracks.length === 0) return
      const batchSize = LIMITS.QUEUE_BATCH_MAX_SIZE
      console.info(`[vinyl] addBatchToDefaultQueue: adding ${tracks.length} tracks in ${Math.ceil(tracks.length / batchSize)} chunks`)
      for (let i = 0; i < tracks.length; i += batchSize) {
        const chunk = tracks.slice(i, i + batchSize)
        socket.emit(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: chunk })
      }
      toast.success(`已添加 ${tracks.length} 首歌到默认播放列表`)
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
