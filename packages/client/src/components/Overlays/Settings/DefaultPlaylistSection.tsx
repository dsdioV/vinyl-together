import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VirtualTrackList, type VirtualTrackListRef } from '@/components/VirtualTrackList'
import { PLATFORM_ACTIVE, PLATFORM_TEXT } from '@/lib/platform'
import { cn, toQueueTrackInput, trackKey } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import { useSearch } from '@/hooks/useSearch'
import { usePlaylist, parsePlaylistInput } from '@/hooks/usePlaylist'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS, LIMITS } from '@music-together/shared'
import type { MusicSource, Playlist, Track } from '@music-together/shared'
import { Loader2, Music2, Search, ListMusic, Hash, ChevronLeft, ChevronRight } from 'lucide-react'
import { motion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PlaylistDetail } from './PlaylistDetail'
import { DefaultPlaylistArchivePanel } from './DefaultPlaylistArchivePanel'
import { TrackListItem } from '@/components/TrackListItem'
import { fetchDefaultQueueTracks } from '@/lib/defaultQueue'
import { emitInChunks } from '@/lib/batchQueueAdd'

const SOURCES: { id: MusicSource; label: string }[] = [
  { id: 'netease', label: '网易云' },
  { id: 'tencent', label: 'QQ' },
  { id: 'kugou', label: '酷狗' },
  { id: 'bilibili', label: 'Bilibili' },
  { id: 'bandcamp', label: 'Bandcamp' },
]

/** 不支持歌单搜索的平台（无歌单概念） */
const PLAYLIST_UNSUPPORTED: ReadonlySet<MusicSource> = new Set(['bilibili', 'bandcamp'])
/** 不支持专辑搜索的平台 */
const ALBUM_UNSUPPORTED: ReadonlySet<MusicSource> = new Set(['bilibili'])

function supportsSearchType(id: MusicSource, type: 'song' | 'album' | 'playlist'): boolean {
  if (type === 'album') return !ALBUM_UNSUPPORTED.has(id)
  if (type === 'playlist') return !PLAYLIST_UNSUPPORTED.has(id)
  return true
}

type PlaylistDetailContext = {
  playlist: Playlist
  source: MusicSource
  type: 'album' | 'playlist'
}

export function DefaultPlaylistSection() {
  const { socket } = useSocketContext()
  const defaultQueue = useRoomStore((s) => s.room?.defaultQueue ?? [])
  const defaultKeys = useMemo(() => new Set(defaultQueue.map(trackKey)), [defaultQueue])
  const remainingCapacity = Math.max(0, LIMITS.DEFAULT_QUEUE_MAX_SIZE - defaultQueue.length)

  const [source, setSource] = useState<MusicSource>('netease')
  const [searchType, setSearchType] = useState<'song' | 'album' | 'playlist'>('song')
  const [keyword, setKeyword] = useState('')
  const [showIdInput, setShowIdInput] = useState(false)
  const [idInput, setIdInput] = useState('')
  const [idLoading, setIdLoading] = useState(false)
  const listRef = useRef<VirtualTrackListRef>(null)
  const sourceContainerRef = useRef<HTMLDivElement>(null)
  const [pillStyle, setPillStyle] = useState({ left: 0, width: 0 })

  // 默认列表：搜索 + 分页
  const [defaultSearchQuery, setDefaultSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const PAGE_SIZE = 50
  const filteredDefaultTracks = useMemo(() => {
    if (!defaultSearchQuery.trim()) return defaultQueue
    const q = defaultSearchQuery.trim().toLowerCase()
    return defaultQueue.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.some((a) => a.toLowerCase().includes(q)),
    )
  }, [defaultQueue, defaultSearchQuery])
  const totalPages = Math.max(1, Math.ceil(filteredDefaultTracks.length / PAGE_SIZE))
  const pageTracks = useMemo(
    () => filteredDefaultTracks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredDefaultTracks, currentPage],
  )
  const roomId = useRoomStore((s) => s.room?.id)
  /** 当前页完整元数据缓存（FIFO 限容，避免全量列表放大客户端内存） */
  const [trackCache, setTrackCache] = useState<Map<string, Track>>(() => new Map())
  /** 补全失败（平台下架/本地资产消失）的引用 ID，避免每次翻页重复请求同一批坏条目 */
  const [failedRefIds, setFailedRefIds] = useState<ReadonlySet<string>>(() => new Set())

  // 批量补全当前页缺失的元数据；补全结果进入缓存，失败条目进入 failed 集合。
  useEffect(() => {
    if (!roomId) return
    const missing = pageTracks
      .filter((ref) => !trackCache.has(ref.id) && !failedRefIds.has(ref.id))
      .map((ref) => ref.id)
    if (missing.length === 0) return
    let cancelled = false
    fetchDefaultQueueTracks(roomId, missing)
      .then(({ tracks, missingIds }) => {
        if (cancelled) return
        if (tracks.length > 0) {
          setTrackCache((prev) => {
            const next = new Map(prev)
            for (const t of tracks) next.set(t.id, t)
            while (next.size > 500) {
              const oldest = next.keys().next().value
              if (oldest === undefined) break
              next.delete(oldest)
            }
            return next
          })
        }
        if (missingIds.length > 0) {
          setFailedRefIds((prev) => {
            const next = new Set(prev)
            for (const id of missingIds) next.add(id)
            return next
          })
        }
      })
      .catch(() => {
        // 网络/服务端错误：不标记 failed，翻页或下次渲染会重试
      })
    return () => {
      cancelled = true
    }
  }, [pageTracks, roomId, trackCache, failedRefIds])

  const displayTracks = useMemo(
    () =>
      pageTracks.map((ref) => {
        const cached = trackCache.get(ref.id)
        if (cached) return cached
        return {
          id: ref.id,
          title: ref.title,
          artist: ref.artist,
          album: '',
          duration: 0,
          cover: '',
          source: ref.source,
          sourceId: ref.sourceId,
          urlId: ref.sourceId,
          ...(ref.assetId ? { assetId: ref.assetId } : {}),
        } satisfies Track
      }),
    [pageTracks, trackCache],
  )
  const handleDefaultSearchChange = useCallback((value: string) => {
    setDefaultSearchQuery(value)
    setCurrentPage(1)
  }, [])

  const { results, loading, loadingMore, hasMore, hasSearched, search, loadMore, resetState } = useSearch(
    source,
    searchType,
  )

  // Playlist detail state
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistDetailContext | null>(null)
  const {
    playlistTracks,
    playlistError,
    playlistTotal,
    tracksLoading,
    loadingMore: playlistLoadingMore,
    hasMoreTracks,
    playlistSearchTracks,
    playlistSearchTotal,
    playlistSearchPage,
    playlistSearchHasMore,
    playlistSearchLoading,
    playlistSearchError,
    fetchPlaylistTracks,
    loadMoreTracks,
    searchPlaylistTracks,
    clearPlaylistSearch,
    fetchTrackById,
  } = usePlaylist()

  // Measure active source button position for sliding pill
  const measurePill = useCallback(() => {
    const container = sourceContainerRef.current
    if (!container) return
    const activeBtn = container.querySelector<HTMLButtonElement>(`[data-source="${source}"]`)
    if (!activeBtn) return
    setPillStyle({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth })
  }, [source])

  useLayoutEffect(() => {
    measurePill()
  }, [measurePill])

  const handleSearch = (overrideKeyword?: string) => {
    const searchKeyword = (overrideKeyword ?? keyword).trim()
    if (!searchKeyword) return
    if (overrideKeyword !== undefined) setKeyword(overrideKeyword)
    search(searchKeyword)
    if (searchType === 'song') {
      listRef.current?.scrollToTop()
    }
  }

  const handleAddToDefault = useCallback(
    (track: Track) => {
      if (remainingCapacity === 0) {
        toast.info('默认播放列表已满')
        return
      }
      const key = trackKey(track)
      if (defaultKeys.has(key)) {
        toast.info(`「${track.title}」已在默认播放列表中`)
        return
      }
      socket.emit(EVENTS.DEFAULT_QUEUE_ADD, { track: toQueueTrackInput(track) })
      toast.success(`「${track.title}」已加入默认播放列表`)
    },
    [socket, defaultKeys, remainingCapacity],
  )

  const handleAddBatchToDefault = useCallback(
    (tracks: Track[]) => {
      const tracksToAdd = tracks.slice(0, remainingCapacity)
      if (tracksToAdd.length === 0) return
      void emitInChunks(tracksToAdd, (chunk) => {
        socket.emit(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: chunk.map(toQueueTrackInput) })
      })
    },
    [socket, remainingCapacity],
  )

  const handleRemoveFromDefault = useCallback(
    (track: Track) => {
      socket.emit(EVENTS.DEFAULT_QUEUE_REMOVE, { trackId: track.id })
    },
    [socket],
  )

  const isTrackInDefault = useCallback((track: Track) => defaultKeys.has(trackKey(track)), [defaultKeys])

  const handleSelectPlaylist = (pl: Playlist) => {
    const type = searchType as 'album' | 'playlist'
    setSelectedPlaylist({ playlist: pl, source, type })
    fetchPlaylistTracks(source, pl.id, pl.trackCount, type)
  }

  const handleBackToSearch = () => {
    setSelectedPlaylist(null)
  }

  const handleIdLookup = async () => {
    const trimmed = idInput.trim()
    if (!trimmed) return

    // Song mode: fetch a single track by ID and add directly to default playlist
    if (searchType === 'song') {
      const parsedId = parsePlaylistInput(trimmed, source)
      if (!parsedId) {
        toast.error('无法识别该 ID 或链接，请检查后重试')
        return
      }

      setIdLoading(true)
      const result = await fetchTrackById(source, parsedId)
      setIdLoading(false)

      if (!result.ok) {
        toast.error(result.message)
        return
      }
      const track = result.track

      if (defaultKeys.has(trackKey(track))) {
        toast.info(`「${track.title}」已在默认播放列表中`)
        return
      }

      handleAddToDefault(track)
      setIdInput('')
      setShowIdInput(false)
      return
    }

    // Album/Playlist mode: open detail view
    const parsedId = parsePlaylistInput(trimmed, source)
    if (!parsedId) {
      toast.error('无法识别该 ID 或链接，请检查后重试')
      return
    }

    setIdLoading(true)
    const fakePlaylist: Playlist = {
      id: parsedId,
      name: `歌单 · ${parsedId}`,
      cover: '',
      trackCount: 0,
      source,
    }
    const type = searchType as 'album' | 'playlist'
    setSelectedPlaylist({ playlist: fakePlaylist, source, type })
    fetchPlaylistTracks(source, parsedId, undefined, type).finally(() => {
      setIdLoading(false)
    })
  }

  return (
    <div>
      <h3 className="text-base font-semibold">默认播放列表</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        主队列为空时自动从中随机抽取歌曲播放。房主和管理员可以自由添加/移除歌曲。
      </p>
      <Separator className="mt-2 mb-4" />

      {/* 存档：把默认列表存进浏览器，一键恢复 / JSON 文件导入导出 */}
      <DefaultPlaylistArchivePanel />

      <Separator className="mt-4 mb-4" />

      {selectedPlaylist ? (
        <PlaylistDetail
          key={`${selectedPlaylist.source}:${selectedPlaylist.type}:${selectedPlaylist.playlist.id}`}
          playlist={selectedPlaylist.playlist}
          playlistSource={selectedPlaylist.source}
          playlistId={selectedPlaylist.playlist.id}
          playlistType={selectedPlaylist.type}
          tracks={playlistTracks}
          loading={tracksLoading}
          loadError={playlistError}
          loadingMore={playlistLoadingMore}
          hasMore={hasMoreTracks}
          total={playlistTotal}
          searchTracks={playlistSearchTracks}
          searchTotal={playlistSearchTotal}
          searchResultPage={playlistSearchPage}
          searchHasMore={playlistSearchHasMore}
          searchLoading={playlistSearchLoading}
          searchError={playlistSearchError}
          onBack={handleBackToSearch}
          onAddTrack={handleAddToDefault}
          onAddAll={handleAddBatchToDefault}
          onLoadMore={loadMoreTracks}
          onSearch={searchPlaylistTracks}
          onClearSearch={clearPlaylistSearch}
          maxAddCount={remainingCapacity}
          addAllTargetLabel="默认播放列表"
          checkedKeys={defaultKeys}
        />
      ) : (
        <>
          {/* Type tabs */}
          <Tabs
            value={searchType}
            onValueChange={(v) => {
              setSearchType(v as 'song' | 'album' | 'playlist')
              resetState()
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="song" className="flex-1 text-xs sm:text-sm">
                单曲
              </TabsTrigger>
              {supportsSearchType(source, 'album') && (
                <TabsTrigger value="album" className="flex-1 text-xs sm:text-sm">
                  专辑
                </TabsTrigger>
              )}
              {supportsSearchType(source, 'playlist') && (
                <TabsTrigger value="playlist" className="flex-1 text-xs sm:text-sm">
                  歌单
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>

          {/* Search */}
          <div className="space-y-3 mt-3">
            <div className="flex items-center gap-2">
              <div
                ref={sourceContainerRef}
                className="bg-muted/50 relative flex items-center rounded-lg p-0.5 shrink-0"
              >
                <motion.div
                  className={cn('absolute inset-y-0.5 rounded-md', PLATFORM_ACTIVE[source])}
                  animate={{ left: pillStyle.left, width: pillStyle.width }}
                  transition={{ type: 'spring', bounce: 0.15, duration: 0.3 }}
                />
                {SOURCES.map((s) => (
                  <button
                    key={s.id}
                    data-source={s.id}
                    className={cn(
                      'relative z-10 rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors',
                      source === s.id ? PLATFORM_TEXT[s.id] : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => {
                      setSource(s.id)
                      resetState()
                      // 切到不支持当前搜索类型的平台时回落到单曲
                      if (!supportsSearchType(s.id, searchType)) setSearchType('song')
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <Input
                placeholder={
                  searchType === 'song'
                    ? source === 'bilibili'
                      ? '搜索视频标题、UP 主...'
                      : '搜索歌曲...'
                    : searchType === 'album'
                      ? '搜索专辑 / 编号...'
                      : '搜索歌单 / 编号...'
                }
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 h-8 text-sm"
                aria-label="搜索添加到默认列表"
              />
              <Button
                size="sm"
                className="h-8 shrink-0"
                onClick={() => handleSearch()}
                disabled={loading}
                aria-label="搜索"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant={showIdInput ? 'default' : 'outline'}
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setShowIdInput((v) => !v)}
                aria-label="按 ID 查找"
                title="按 ID / 链接精确查找"
              >
                <Hash className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* ID lookup input */}
            {showIdInput && (
              <div className="flex gap-2">
                <Input
                  placeholder={
                    searchType === 'song'
                      ? '输入歌曲 ID 或链接'
                      : searchType === 'album'
                        ? '输入专辑链接或编号'
                        : '输入歌单 ID 或链接'
                  }
                  value={idInput}
                  onChange={(e) => setIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleIdLookup()}
                  className="flex-1 h-8 text-sm"
                  aria-label={searchType === 'song' ? '歌曲 ID 或链接' : '歌单 ID 或链接'}
                />
                <Button
                  onClick={handleIdLookup}
                  disabled={idLoading}
                  size="sm"
                  className="h-8 shrink-0"
                  aria-label="按 ID 查找"
                >
                  {idLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '查找'}
                </Button>
              </div>
            )}

            {/* Search results */}
            {hasSearched &&
              (searchType === 'song' ? (
                <div className="flex max-h-48 min-h-0 flex-col overflow-hidden rounded-md border">
                  <VirtualTrackList
                    ref={listRef}
                    tracks={results as Track[]}
                    loading={loading}
                    hasMore={hasMore}
                    loadingMore={loadingMore}
                    onLoadMore={loadMore}
                    isTrackAdded={isTrackInDefault}
                    onAddTrack={handleAddToDefault}
                    emptyIcon={<Music2 className="h-8 w-8" />}
                    emptyMessage="暂无结果，换个关键词试试"
                  />
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-md border p-2">
                  {loading && results.length === 0 ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : results.length === 0 ? (
                    <div className="flex h-24 flex-col items-center justify-center gap-2 text-muted-foreground">
                      <Music2 className="h-6 w-6" />
                      <span className="text-xs">暂无结果，换个关键词试试</span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {(results as Playlist[]).map((pl, index) => (
                        <button
                          key={`${pl.id}-${index}`}
                          className="hover:bg-accent flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg p-2 text-left transition-colors"
                          onClick={() => handleSelectPlaylist(pl)}
                        >
                          {pl.cover ? (
                            <img
                              src={pl.cover}
                              alt={pl.name}
                              className="h-10 w-10 shrink-0 rounded-md object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-md">
                              <ListMusic className="text-muted-foreground h-5 w-5" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{pl.name}</p>
                            <p className="text-muted-foreground truncate text-xs">
                              {pl.trackCount} 首{pl.creator ? ` · ${pl.creator}` : ''}
                            </p>
                          </div>
                        </button>
                      ))}
                      {hasMore && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full mt-1"
                          onClick={loadMore}
                          disabled={loadingMore}
                        >
                          {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                          {loadingMore ? '加载中...' : '加载更多'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </>
      )}

      <Separator className="mt-4 mb-4" />

      {/* Current default playlist tracks */}
      <p className="text-muted-foreground mb-2 text-xs">
        默认列表 · {defaultQueue.length} 首歌
        {defaultSearchQuery.trim() && `（筛选出 ${filteredDefaultTracks.length} 首）`}
      </p>

      {/* Search inside default playlist */}
      {defaultQueue.length > 0 && (
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="在当前列表中搜索歌名或歌手..."
            value={defaultSearchQuery}
            onChange={(e) => handleDefaultSearchChange(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
      )}

      {defaultQueue.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-md border text-muted-foreground">
          <Music2 className="h-6 w-6" />
          <span className="text-xs">尚未添加歌曲到默认列表</span>
        </div>
      ) : filteredDefaultTracks.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-md border text-muted-foreground">
          <Music2 className="h-6 w-6" />
          <span className="text-xs">未找到匹配的歌曲</span>
        </div>
      ) : (
        <>
          <div className="max-h-64 overflow-x-hidden overflow-y-auto rounded-md border">
            <div className="grid grid-cols-1 divide-y">
              {displayTracks.map((track) => {
                const globalIndex = defaultQueue.findIndex((t) => t.id === track.id)
                return (
                  <TrackListItem
                    key={track.id}
                    track={track}
                    index={globalIndex}
                    isAdded={false}
                    onAdd={() => {}}
                    onRemove={handleRemoveFromDefault}
                  />
                )
              })}
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="gap-1"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一页
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="gap-1"
              >
                下一页
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
