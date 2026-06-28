import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { VirtualTrackList } from '@/components/VirtualTrackList'
import { trackKey } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import type { Playlist, Track } from '@music-together/shared'
import { ArrowLeft, ListPlus, Music } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

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
  onLoadMore: () => void
  /** Maximum number of tracks that can be added. Omit to allow unlimited additions. */
  maxAddCount?: number
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
  onLoadMore,
  maxAddCount,
  checkedKeys,
}: PlaylistDetailProps) {
  const queue = useRoomStore((s) => s.room?.queue ?? EMPTY_QUEUE)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())
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
  // maxAddCount limits how many tracks can be added (e.g. main queue capacity).
  // When omitted, no limit is enforced (e.g. default playlist which has no server-side cap).
  const effectiveMax = maxAddCount ?? Infinity
  const availableSlots = effectiveMax - queue.length
  const uniqueTracks = useMemo(() => tracks.filter((t) => !isTrackAdded(t)), [tracks, isTrackAdded])
  const addCount = Math.min(availableSlots, uniqueTracks.length)
  const isQueueFull = availableSlots <= 0

  const handleAddAll = useCallback(() => {
    if (addCount <= 0) return
    const toAdd = uniqueTracks.slice(0, addCount)
    onAddAll(toAdd, playlist?.name)
    setAddedIds((prev) => {
      const next = new Set(prev)
      for (const t of toAdd) next.add(trackKey(t))
      return next
    })
    if (addCount < uniqueTracks.length) {
      toast.success(`已添加 ${addCount} 首到队列（队列已满，还有 ${uniqueTracks.length - addCount} 首未添加）`)
    } else {
      toast.success(`已添加全部 ${addCount} 首到队列`)
    }
  }, [addCount, uniqueTracks, onAddAll, playlist?.name])

  // Button label
  let addAllLabel: string
  if (loading) {
    addAllLabel = '加载中…'
  } else if (tracks.length === 0) {
    addAllLabel = '添加全部'
  } else if (isQueueFull) {
    addAllLabel = '队列已满'
  } else if (uniqueTracks.length === 0) {
    addAllLabel = '全部已添加'
  } else if (addCount === uniqueTracks.length) {
    addAllLabel = `添加全部 ${addCount} 首`
  } else {
    addAllLabel = `添加 ${addCount} 首到队列`
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

      {/* Row 2: Info + Action */}
      <div className="flex shrink-0 items-center justify-between gap-3 py-1">
        <p className="text-muted-foreground text-xs">
          {loading
            ? '加载中…'
            : `${total} 首${tracks.length < total ? `（已加载 ${tracks.length}）` : ''}${playlist?.creator ? ` · ${playlist.creator}` : ''}`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddAll}
          disabled={loading || isQueueFull || uniqueTracks.length === 0}
          className="shrink-0 gap-1"
        >
          <ListPlus className="h-3.5 w-3.5" />
          {addAllLabel}
        </Button>
      </div>

      <Separator className="shrink-0" />

      {/* Track list with shared virtual scrolling component */}
      <VirtualTrackList
        tracks={tracks}
        loading={loading}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        isTrackAdded={isTrackAdded}
        onAddTrack={handleAddTrack}
        onInsertAfterCurrent={onInsertAfterCurrent ? handleInsertAfterCurrent : undefined}
        emptyIcon={<Music className="h-8 w-8" />}
        emptyMessage="歌单为空"
        className="border-0 rounded-none"
      />
    </div>
  )
}
