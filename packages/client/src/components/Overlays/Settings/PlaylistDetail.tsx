import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { VirtualTrackList } from '@/components/VirtualTrackList'
import { trackKey } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import type { Playlist, Track } from '@music-together/shared'
import { ArrowLeft, Library, ListPlus, Music, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'

const EMPTY_QUEUE: Track[] = []

interface PlaylistDetailProps {
  playlist: Playlist | null
  tracks: Track[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  total: number
  onBack: () => void
  onAddTrack: (track: Track) => void
  onInsertAfterCurrent?: (track: Track) => void
  onAddAll: (tracks: Track[], playlistName?: string) => void
  onAddToDefault?: (tracks: Track[], playlistName?: string) => void
  onLoadMore: () => void
  /** Maximum number of tracks that can be added. Omit to allow unlimited additions. */
  /**
   * Optional set of track keys to treat as "already added".
   * When omitted, the main queue is used (default for PlatformHub).
   * Pass defaultKeys when used inside DefaultPlaylistSection so that
   * tracks already in the main queue can still be added to the default playlist.
   */
  checkedKeys?: Set<string>
}

export function PlaylistDetail({
  playlist,
  tracks,
  loading,
  loadingMore,
  hasMore,
  total,
  onBack,
  onAddTrack,
  onInsertAfterCurrent,
  onAddAll,
  onAddToDefault,
  onLoadMore,
  checkedKeys,
}: PlaylistDetailProps) {
  const queue = useRoomStore((s) => s.room?.queue ?? EMPTY_QUEUE)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  // Song-list search & pagination
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPage, setSearchPage] = useState(1)
  const SEARCH_PAGE_SIZE = 50

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return null // null = no filter, use original tracks
    const q = searchQuery.trim().toLowerCase()
    return tracks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.some((a) => a.toLowerCase().includes(q)),
    )
  }, [tracks, searchQuery])

  const isSearching = filteredTracks !== null
  const displayTracks = filteredTracks ?? tracks
  const searchTotalPages = Math.max(1, Math.ceil((filteredTracks?.length ?? 0) / SEARCH_PAGE_SIZE))
  const searchPageTracks = useMemo(
    () => isSearching ? displayTracks.slice((searchPage - 1) * SEARCH_PAGE_SIZE, searchPage * SEARCH_PAGE_SIZE) : displayTracks,
    [displayTracks, isSearching, searchPage],
  )
  const queueKeys = useMemo(() => new Set(queue.map(trackKey)), [queue])
  // When checkedKeys is provided (e.g. defaultKeys for default playlist),
  // use it instead of queueKeys to determine "already added" state.
  const alreadyAddedKeys = checkedKeys ?? queueKeys

  const isTrackAdded = useCallback(
    (track: Track) => {
      const key = trackKey(track)
      return addedIds.has(key) || alreadyAddedKeys.has(key)
    },
    [addedIds, alreadyAddedKeys],
  )

  const handleAddTrack = useCallback(
    (track: Track) => {
      const key = trackKey(track)
      if (alreadyAddedKeys.has(key) || addedIds.has(key)) {
        toast.info(`「${track.title}」已在队列中`)
        return
      }
      onAddTrack(track)
      setAddedIds((prev) => new Set(prev).add(key))
    },
    [onAddTrack, alreadyAddedKeys, addedIds],
  )

  const handleInsertAfterCurrent = useCallback(
    (track: Track) => {
      const key = trackKey(track)
      if (alreadyAddedKeys.has(key) || addedIds.has(key)) {
        toast.info(`「${track.title}」已在队列中`)
        return
      }
      onInsertAfterCurrent?.(track)
      setAddedIds((prev) => new Set(prev).add(key))
    },
    [onInsertAfterCurrent, alreadyAddedKeys, addedIds],
  )

  // Dynamic "add all" logic — filter duplicates
  const uniqueTracks = useMemo(() => tracks.filter((t) => !isTrackAdded(t)), [tracks, isTrackAdded])

  const handleAddAll = useCallback(() => {
    if (uniqueTracks.length === 0) return
    onAddAll(uniqueTracks, playlist?.name)
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const t of uniqueTracks) next.add(trackKey(t))
      return next
    })
    toast.success(`已添加 ${uniqueTracks.length} 首到队列`)
  }, [uniqueTracks, onAddAll, playlist?.name])

  const handleAddToDefault = useCallback(() => {
    if (!onAddToDefault) return
    if (uniqueTracks.length === 0) return
    onAddToDefault(uniqueTracks, playlist?.name)
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const t of uniqueTracks) next.add(trackKey(t))
      return next
    })
  }, [uniqueTracks, onAddToDefault, playlist?.name])

  // Button label
  let addAllLabel: string
  if (loading) {
    addAllLabel = '加载中…'
  } else if (tracks.length === 0) {
    addAllLabel = '添加全部'
  } else if (uniqueTracks.length === 0) {
    addAllLabel = '全部已添加'
  } else {
    addAllLabel = `添加全部 ${uniqueTracks.length} 首`
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Row 1: Back + Title — pr-8 reserves space for dialog close button */}
      <div className="flex shrink-0 items-center gap-2 pr-8">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{playlist?.name ?? '歌单详情'}</h4>
      </div>

      {/* Search box */}
      {tracks.length > 0 && (
        <div className="relative shrink-0">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchPage(1) }}
            placeholder="搜索歌单内歌曲…"
            className="h-8 pl-8 pr-3 text-xs"
          />
        </div>
      )}

      {/* Row 2: Info + Action */}
      <div className="flex shrink-0 items-center justify-between gap-3 py-1">
        <p className="text-muted-foreground text-xs">
          {loading
            ? '加载中…'
            : isSearching
              ? `搜索到 ${filteredTracks!.length} 首${tracks.length < total ? `（已加载 ${tracks.length} / ${total}，搜索范围可能不完整）` : ''}`
              : `${total} 首${tracks.length < total ? `（已加载 ${tracks.length}）` : ''}${playlist?.creator ? ` · ${playlist.creator}` : ''}`}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {onAddToDefault && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddToDefault}
              disabled={loading || uniqueTracks.length === 0}
              className="shrink-0 gap-1"
            >
              <Library className="h-3.5 w-3.5" />
              加入默认列表
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddAll}
            disabled={loading || uniqueTracks.length === 0}
            className="shrink-0 gap-1"
          >
            <ListPlus className="h-3.5 w-3.5" />
            {addAllLabel}
          </Button>
        </div>
      </div>

      <Separator className="shrink-0" />

      {/* Track list with shared virtual scrolling component */}
      <VirtualTrackList
        tracks={searchPageTracks}
        loading={loading}
        hasMore={isSearching ? false : hasMore}
        loadingMore={loadingMore}
        onLoadMore={isSearching ? () => {} : onLoadMore}
        isTrackAdded={isTrackAdded}
        onAddTrack={handleAddTrack}
        onInsertAfterCurrent={onInsertAfterCurrent ? handleInsertAfterCurrent : undefined}
        emptyIcon={<Music className="h-8 w-8" />}
        emptyMessage={isSearching ? '没有匹配的歌曲' : '歌单为空'}
        className="border-0 rounded-none"
      />

      {/* Pagination for search results */}
      {isSearching && searchTotalPages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={searchPage <= 1}
            onClick={() => setSearchPage((p) => Math.max(1, p - 1))}
            className="gap-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {searchPage} / {searchTotalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={searchPage >= searchTotalPages}
            onClick={() => setSearchPage((p) => Math.min(searchTotalPages, p + 1))}
            className="gap-1"
          >
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
