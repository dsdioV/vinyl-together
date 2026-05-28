import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VirtualTrackList, type VirtualTrackListRef } from '@/components/VirtualTrackList'
import { PLATFORM_ACTIVE, PLATFORM_TEXT } from '@/lib/platform'
import { cn, trackKey } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import { useSearch } from '@/hooks/useSearch'
import { usePlaylist, parsePlaylistInput } from '@/hooks/usePlaylist'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS, LIMITS } from '@music-together/shared'
import type { MusicSource, Track, Playlist } from '@music-together/shared'
import { Loader2, Music2, Search, ListMusic, Hash } from 'lucide-react'
import { motion } from 'motion/react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PlaylistDetail } from './PlaylistDetail'
import { TrackListItem } from '@/components/TrackListItem'

const SOURCES: { id: MusicSource; label: string }[] = [
  { id: 'netease', label: '网易云' },
  { id: 'tencent', label: 'QQ' },
  { id: 'kugou', label: '酷狗' },
]

export function DefaultPlaylistSection() {
  const { socket } = useSocketContext()
  const defaultQueue = useRoomStore((s) => s.room?.defaultQueue ?? [])
  const defaultKeys = useMemo(() => new Set(defaultQueue.map(trackKey)), [defaultQueue])

  const [source, setSource] = useState<MusicSource>('netease')
  const [searchType, setSearchType] = useState<'song' | 'album' | 'playlist'>('song')
  const [keyword, setKeyword] = useState('')
  const [showIdInput, setShowIdInput] = useState(false)
  const [idInput, setIdInput] = useState('')
  const [idLoading, setIdLoading] = useState(false)
  const listRef = useRef<VirtualTrackListRef>(null)
  const sourceContainerRef = useRef<HTMLDivElement>(null)
  const [pillStyle, setPillStyle] = useState({ left: 0, width: 0 })

  const { results, loading, loadingMore, hasMore, hasSearched, search, loadMore, resetState } = useSearch(source, searchType)

  // Playlist detail state
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null)
  const {
    playlistTracks,
    playlistTotal,
    tracksLoading,
    loadingMore: playlistLoadingMore,
    hasMoreTracks,
    fetchPlaylistTracks,
    loadMoreTracks,
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
      const key = trackKey(track)
      if (defaultKeys.has(key)) {
        toast.info(`「${track.title}」已在默认播放列表中`)
        return
      }
      socket.emit(EVENTS.DEFAULT_QUEUE_ADD, { track })
      toast.success(`「${track.title}」已加入默认播放列表`)
    },
    [socket, defaultKeys],
  )

  const handleAddBatchToDefault = useCallback(
    (tracks: Track[]) => {
      if (tracks.length === 0) return
      const batchSize = LIMITS.QUEUE_BATCH_MAX_SIZE
      for (let i = 0; i < tracks.length; i += batchSize) {
        const chunk = tracks.slice(i, i + batchSize)
        socket.emit(EVENTS.DEFAULT_QUEUE_ADD_BATCH, { tracks: chunk })
      }
      toast.success(`已添加 ${tracks.length} 首歌到默认播放列表`)
    },
    [socket],
  )

  const handleRemoveFromDefault = useCallback(
    (track: Track) => {
      socket.emit(EVENTS.DEFAULT_QUEUE_REMOVE, { trackId: track.id })
    },
    [socket],
  )

  const isTrackInDefault = useCallback(
    (track: Track) => defaultKeys.has(trackKey(track)),
    [defaultKeys],
  )

  const handleSelectPlaylist = (pl: Playlist) => {
    setSelectedPlaylist(pl)
    fetchPlaylistTracks(source, pl.id, pl.trackCount, searchType as 'album' | 'playlist')
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
      const track = await fetchTrackById(source, parsedId)
      setIdLoading(false)

      if (!track) {
        toast.error('未找到该歌曲，请检查 ID 是否正确')
        return
      }

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
    setSelectedPlaylist(fakePlaylist)
    fetchPlaylistTracks(source, parsedId, undefined, searchType as 'album' | 'playlist').finally(() => {
      setIdLoading(false)
    })
  }

  return (
    <div>
      <h3 className="text-base font-semibold">默认播放列表</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        主队列为空时自动从中随机抽取歌曲播放。房主可以自由添加/移除歌曲。
      </p>
      <Separator className="mt-2 mb-4" />

      {selectedPlaylist ? (
        <PlaylistDetail
          playlist={selectedPlaylist}
          tracks={playlistTracks}
          loading={tracksLoading}
          loadingMore={playlistLoadingMore}
          hasMore={hasMoreTracks}
          total={playlistTotal}
          onBack={handleBackToSearch}
          onAddTrack={handleAddToDefault}
          onAddAll={handleAddBatchToDefault}
          onLoadMore={loadMoreTracks}
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
              <TabsTrigger value="song" className="flex-1 text-xs sm:text-sm">单曲</TabsTrigger>
              <TabsTrigger value="album" className="flex-1 text-xs sm:text-sm">专辑</TabsTrigger>
              <TabsTrigger value="playlist" className="flex-1 text-xs sm:text-sm">歌单</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Search */}
          <div className="space-y-3 mt-3">
            <div className="flex items-center gap-2">
              <div ref={sourceContainerRef} className="bg-muted/50 relative flex items-center rounded-lg p-0.5 shrink-0">
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
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <Input
                placeholder={
                  searchType === 'song' ? '搜索歌曲...' : searchType === 'album' ? '搜索专辑 / 编号...' : '搜索歌单 / 编号...'
                }
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 h-8 text-sm"
                aria-label="搜索添加到默认列表"
              />
              <Button size="sm" className="h-8 shrink-0" onClick={() => handleSearch()} disabled={loading} aria-label="搜索">
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
                  placeholder={searchType === 'song' ? '输入歌曲 ID 或链接' : '输入歌单 ID 或链接'}
                  value={idInput}
                  onChange={(e) => setIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleIdLookup()}
                  className="flex-1 h-8 text-sm"
                  aria-label={searchType === 'song' ? '歌曲 ID 或链接' : '歌单 ID 或链接'}
                />
                <Button onClick={handleIdLookup} disabled={idLoading} size="sm" className="h-8 shrink-0" aria-label="按 ID 查找">
                  {idLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '查找'}
                </Button>
              </div>
            )}

            {/* Search results */}
            {hasSearched && (
              searchType === 'song' ? (
                <div className="rounded-md border max-h-48 overflow-hidden">
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
              )
            )}
          </div>
        </>
      )}

      <Separator className="mt-4 mb-4" />

      {/* Current default playlist tracks */}
      <p className="text-muted-foreground mb-2 text-xs">
        默认列表 · {defaultQueue.length} 首歌
      </p>
      {defaultQueue.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-2 rounded-md border text-muted-foreground">
          <Music2 className="h-6 w-6" />
          <span className="text-xs">尚未添加歌曲到默认列表</span>
        </div>
      ) : (
        <div className="max-h-64 overflow-x-hidden overflow-y-auto rounded-md border">
          <div className="grid grid-cols-1 divide-y">
            {defaultQueue.map((track, index) => (
              <TrackListItem
                key={track.id}
                track={track}
                index={index}
                isAdded={false}
                onAdd={() => {}}
                onRemove={handleRemoveFromDefault}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}