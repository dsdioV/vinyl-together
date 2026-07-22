import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { VirtualTrackList } from '@/components/VirtualTrackList'
import { trackKey } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import { LIMITS, type MusicSource, type Playlist, type Track } from '@music-together/shared'
import { ArrowLeft, Library, ListPlus, Music, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'

const EMPTY_QUEUE: Track[] = []

interface PlaylistDetailProps {
  playlist: Playlist | null
  playlistSource: MusicSource
  playlistId: string
  playlistType: 'playlist' | 'album'
  tracks: Track[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  total: number
  searchTracks: Track[]
  searchTotal: number
  searchResultPage: number
  searchHasMore: boolean
  searchLoading: boolean
  searchError: string | null
  onBack: () => void
  onAddTrack: (track: Track) => void
  onInsertAfterCurrent?: (track: Track) => void
  onAddAll: (tracks: Track[], playlistName?: string) => void
  onAddToDefault?: (tracks: Track[], playlistName?: string) => void
  onLoadMore: () => void
  onSearch: (
    source: MusicSource,
    playlistId: string,
    keyword: string,
    page: number,
    trackCount?: number,
    type?: 'playlist' | 'album',
  ) => Promise<void>
  onClearSearch: () => void
  /** Maximum number of tracks that can be added. Omit to allow unlimited additions. */
  maxAddCount?: number
  /** Label used by the bulk-add success toast. Defaults to the main queue. */
  addAllTargetLabel?: string
  /** Maximum number of tracks that can be added through onAddToDefault. */
  maxDefaultAddCount?: number
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
  playlistSource,
  playlistId,
  playlistType,
  tracks,
  loading,
  loadingMore,
  hasMore,
  total,
  searchTracks,
  searchTotal,
  searchResultPage,
  searchHasMore,
  searchLoading,
  searchError,
  onBack,
  onAddTrack,
  onInsertAfterCurrent,
  onAddAll,
  onAddToDefault,
  onLoadMore,
  onSearch,
  onClearSearch,
  maxAddCount,
  addAllTargetLabel,
  maxDefaultAddCount,
  checkedKeys,
}: PlaylistDetailProps) {
  const queue = useRoomStore((s) => s.room?.queue ?? EMPTY_QUEUE)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  // Full remote playlist search. Browsing tracks remain untouched so clearing
  // the keyword immediately restores the existing virtual/infinite list.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPage, setSearchPage] = useState(1)
  const [searchDebouncing, setSearchDebouncing] = useState(false)
  const normalizedSearchQuery = searchQuery.trim()
  const isSearching = normalizedSearchQuery.length > 0
  const displayTracks = isSearching ? searchTracks : tracks
  const displayLoading = isSearching ? searchDebouncing || searchLoading : loading
  const searchTotalPages = Math.max(1, Math.ceil(searchTotal / LIMITS.PLAYLIST_SEARCH_PAGE_SIZE))

  useEffect(() => {
    return () => onClearSearch()
  }, [onClearSearch])

  useEffect(() => {
    if (!normalizedSearchQuery) return

    const timeout = window.setTimeout(() => {
      void onSearch(playlistSource, playlistId, normalizedSearchQuery, searchPage, total, playlistType)
      setSearchDebouncing(false)
    }, 300)

    return () => window.clearTimeout(timeout)
  }, [normalizedSearchQuery, onSearch, playlistId, playlistSource, playlistType, searchPage, total])

  const handleSearchChange = useCallback(
    (value: string) => {
      const nextNormalizedQuery = value.trim()

      // Keep the displayed value in sync without resetting a search whose
      // effective keyword did not change (for example, adding a trailing
      // space). Since the effect depends on the normalized value, clearing
      // here would otherwise leave the UI waiting for a request that will
      // never be scheduled.
      if (nextNormalizedQuery === normalizedSearchQuery) {
        setSearchQuery(value)
        return
      }

      // Clear the previous keyword's page in the same event as the input update;
      // Abort/request-id guards alone would still leave stale UI during debounce.
      onClearSearch()
      setSearchQuery(value)
      setSearchPage(1)
      setSearchDebouncing(nextNormalizedQuery.length > 0)
    },
    [normalizedSearchQuery, onClearSearch],
  )

  const handleSearchPageChange = useCallback(
    (page: number) => {
      const nextPage = Math.min(searchTotalPages, Math.max(1, page))
      if (nextPage === searchPage) return
      onClearSearch()
      setSearchPage(nextPage)
      setSearchDebouncing(true)
    },
    [onClearSearch, searchPage, searchTotalPages],
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
  const uniqueTracks = useMemo(() => displayTracks.filter((t) => !isTrackAdded(t)), [displayTracks, isTrackAdded])
  const addAllTracks = useMemo(
    () => uniqueTracks.slice(0, maxAddCount === undefined ? uniqueTracks.length : Math.max(0, maxAddCount)),
    [uniqueTracks, maxAddCount],
  )
  const defaultAddTracks = useMemo(
    () =>
      uniqueTracks.slice(0, maxDefaultAddCount === undefined ? uniqueTracks.length : Math.max(0, maxDefaultAddCount)),
    [uniqueTracks, maxDefaultAddCount],
  )

  const handleAddAll = useCallback(() => {
    if (addAllTracks.length === 0) return
    onAddAll(addAllTracks, playlist?.name)
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const t of addAllTracks) next.add(trackKey(t))
      return next
    })
    toast.success(`已添加 ${addAllTracks.length} 首到${addAllTargetLabel ?? '队列'}`)
  }, [addAllTracks, onAddAll, playlist?.name, addAllTargetLabel])

  const handleAddToDefault = useCallback(() => {
    if (!onAddToDefault) return
    if (defaultAddTracks.length === 0) return
    onAddToDefault(defaultAddTracks, playlist?.name)
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const t of defaultAddTracks) next.add(trackKey(t))
      return next
    })
  }, [defaultAddTracks, onAddToDefault, playlist?.name])

  // Button label
  let addAllLabel: string
  if (displayLoading) {
    addAllLabel = '加载中…'
  } else if (displayTracks.length === 0) {
    addAllLabel = '添加全部'
  } else if (addAllTracks.length === 0) {
    addAllLabel = maxAddCount === 0 ? '已达上限' : '全部已添加'
  } else {
    addAllLabel = isSearching ? `添加本页 ${addAllTracks.length} 首` : `添加全部 ${addAllTracks.length} 首`
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
      {(tracks.length > 0 || total > 0 || isSearching) && (
        <div className="relative shrink-0">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="搜索歌单内歌曲…"
            aria-label="搜索歌单内歌曲"
            maxLength={LIMITS.SEARCH_KEYWORD_MAX_LENGTH}
            className="h-8 pl-8 pr-3 text-xs"
          />
        </div>
      )}

      {/* Row 2: Info + Action */}
      <div className="flex shrink-0 items-center justify-between gap-3 py-1">
        <p className="text-muted-foreground text-xs">
          {displayLoading
            ? '加载中…'
            : isSearching
              ? searchError
                ? '搜索失败'
                : `搜索到 ${searchTotal} 首 · 第 ${searchResultPage} / ${searchTotalPages} 页`
              : `${total} 首${tracks.length < total ? `（已加载 ${tracks.length}）` : ''}${playlist?.creator ? ` · ${playlist.creator}` : ''}`}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {onAddToDefault && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddToDefault}
              disabled={displayLoading || defaultAddTracks.length === 0}
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
            disabled={displayLoading || addAllTracks.length === 0}
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
        tracks={displayTracks}
        loading={displayLoading}
        hasMore={isSearching ? false : hasMore}
        loadingMore={loadingMore}
        onLoadMore={isSearching ? () => {} : onLoadMore}
        isTrackAdded={isTrackAdded}
        onAddTrack={handleAddTrack}
        onInsertAfterCurrent={onInsertAfterCurrent ? handleInsertAfterCurrent : undefined}
        emptyIcon={<Music className="h-8 w-8" />}
        emptyMessage={isSearching ? searchError || '没有匹配的歌曲' : '歌单为空'}
        className="border-0 rounded-none"
      />

      {/* Pagination for search results */}
      {isSearching && !displayLoading && !searchError && searchTotalPages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={searchPage <= 1}
            onClick={() => handleSearchPageChange(searchPage - 1)}
            className="gap-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {searchResultPage} / {searchTotalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={searchPage >= searchTotalPages || !searchHasMore}
            onClick={() => handleSearchPageChange(searchPage + 1)}
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
