import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, getSourceUrl } from '@/lib/utils'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import type { Track } from '@music-together/shared'
import { EVENTS } from '@music-together/shared'
import { useHasHover } from '@/hooks/useHasHover'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AbilityContext } from '@/providers/AbilityProvider'
import { ArrowUpToLine, ChevronDown, ChevronUp, ExternalLink, Heart, ListX, Music, Play, Trash2, User, X } from 'lucide-react'
import { toast } from 'sonner'
import { MarqueeText } from '@/components/ui/marquee-text'
import type { MusicSource } from '@music-together/shared'
import { storage } from '@/lib/storage'

const EMPTY_QUEUE: Track[] = []
const EMPTY_LIKES: Record<string, string[]> = {}

const SOURCE_STYLE: Record<MusicSource, { label: string; className: string }> = {
  netease: { label: '网易', className: 'text-white bg-red-500 ring-red-600/50' },
  tencent: { label: 'QQ', className: 'text-white bg-green-500 ring-green-600/50' },
  kugou: { label: '酷狗', className: 'text-white bg-blue-500 ring-blue-600/50' },
}

interface QueueDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoveFromQueue: (trackId: string) => void
  onReorderQueue: (trackIds: string[]) => void
  onClearQueue: () => void
}

export function QueueDrawer({ open, onOpenChange, onRemoveFromQueue, onReorderQueue, onClearQueue }: QueueDrawerProps) {
  const queue = useRoomStore((s) => s.room?.queue ?? EMPTY_QUEUE)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const trackLikes = useRoomStore((s) => s.room?.trackLikes ?? EMPTY_LIKES)
  const songLikes = useRoomStore((s) => s.room?.songLikes ?? false)
  const myId = storage.getUserId()
  const { socket } = useSocketContext()
  const isMobile = useIsMobile() // layout: Drawer direction, height
  const hasHover = useHasHover() // interaction: hover vs touch
  const isTouch = !hasHover
  const ability = useContext(AbilityContext)
  const canRemove = ability.can('remove', 'Queue')
  const canReorder = ability.can('reorder', 'Queue')
  const canPlay = ability.can('play', 'Player')
  const canVote = ability.can('vote', 'Player')
  const [confirmClear, setConfirmClear] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mobile: track which item has its action toolbar visible
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null)
  // Desktop: after clicking an action, temporarily suppress the hover toolbar until the cursor leaves the item
  const [dismissedHoverTrackId, setDismissedHoverTrackId] = useState<string | null>(null)

  // Toggle: show queue in original order or sorted by likes (when songLikes mode is on)
  const [sortByLikes, setSortByLikes] = useState(false)

  useEffect(() => {
    setSortByLikes(songLikes)
  }, [songLikes])

  const displayQueue = useMemo<Track[]>(() => {
    if (!songLikes || !sortByLikes) return queue
    return [...queue].sort((a, b) => {
      // Current track always first
      if (a.id === currentTrack?.id) return -1
      if (b.id === currentTrack?.id) return 1
      // Then sort by likes desc → queue index asc
      const aLikes = trackLikes[a.id]?.length ?? 0
      const bLikes = trackLikes[b.id]?.length ?? 0
      if (bLikes !== aLikes) return bLikes - aLikes
      return queue.indexOf(a) - queue.indexOf(b)
    })
  }, [songLikes, sortByLikes, queue, trackLikes, currentTrack?.id])

  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: displayQueue.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 56,
    overscan: 5,
  })

  // Clear the confirm-dismiss timer on unmount
  useEffect(
    () => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    },
    [],
  )

  const handleClear = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true)
      // Auto-dismiss after 3s
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null
        setConfirmClear(false)
      }, 3000)
      return
    }
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    onClearQueue()
    setConfirmClear(false)
    toast.success('播放列表已清空')
  }, [confirmClear, onClearQueue])

  const handleMoveUp = (displayIndex: number) => {
    const track = displayQueue[displayIndex]
    if (!track) return
    const realIndex = queue.indexOf(track)
    if (realIndex <= 0) return
    const ids = queue.map((t) => t.id)
    ;[ids[realIndex - 1], ids[realIndex]] = [ids[realIndex], ids[realIndex - 1]]
    onReorderQueue(ids)
  }

  const handleMoveDown = (displayIndex: number) => {
    const track = displayQueue[displayIndex]
    if (!track) return
    const realIndex = queue.indexOf(track)
    if (realIndex < 0 || realIndex >= queue.length - 1) return
    const ids = queue.map((t) => t.id)
    ;[ids[realIndex], ids[realIndex + 1]] = [ids[realIndex + 1], ids[realIndex]]
    onReorderQueue(ids)
  }

  const handlePlayTrack = (track: Track) => {
    if (canPlay) {
      socket.emit(EVENTS.PLAYER_PLAY, { track })
    } else if (canVote) {
      socket.emit(EVENTS.VOTE_START, {
        action: 'play-track' as const,
        payload: { trackId: track.id, trackTitle: track.title },
      })
      toast.info(`已发起投票：播放「${track.title}」`)
    }
  }

  const handleRemoveTrack = (track: Track) => {
    if (canRemove) {
      onRemoveFromQueue(track.id)
      toast.success(`已移除「${track.title}」`)
    } else if (canVote) {
      socket.emit(EVENTS.VOTE_START, {
        action: 'remove-track' as const,
        payload: { trackId: track.id, trackTitle: track.title },
      })
      toast.info(`已发起投票：移除「${track.title}」`)
    }
  }

  const handleLikeToggle = useCallback(
    (track: Track) => {
      const likedByMe = trackLikes[track.id]?.includes(myId) ?? false
      if (likedByMe) {
        socket.emit(EVENTS.QUEUE_UNLIKE, { trackId: track.id })
      } else {
        socket.emit(EVENTS.QUEUE_LIKE, { trackId: track.id })
      }
    },
    [socket, trackLikes, myId],
  )

  const handleInsertAfterCurrent = (track: Track, e?: MouseEvent) => {
    // If this was triggered from inside the floating actions, hide it immediately.
    // - Touch: activeTrackId controls visibility
    // - Desktop: group-hover/group-focus-within can keep it visible after DOM reorders (transform keeps hover)
    if (e) {
      e.stopPropagation()
      ;(e.currentTarget as HTMLButtonElement | null)?.blur()
    }
    if (isTouch && activeTrackId === track.id) setActiveTrackId(null)
    if (!isTouch) setDismissedHoverTrackId(track.id)
    const current = currentTrack
    const currentIndex = current?.id ? queue.findIndex((t) => t.id === current.id) : -1

    if (current && track.id === current.id) return

    const ids = queue.map((t) => t.id)
    const from = ids.indexOf(track.id)
    if (from < 0) return

    // 先移除再插入，避免重复
    ids.splice(from, 1)

    if (currentIndex >= 0) {
      // 目标位置：当前播放歌曲的下方（已播放的在上方，不动）
      // 如果被移动的歌曲在 current 之前，移除后 currentIndex 会左移一位
      const adjustedCurrentIndex = from < currentIndex ? currentIndex - 1 : currentIndex
      const to = adjustedCurrentIndex + 1
      ids.splice(to, 0, track.id)
    } else {
      // 无 currentTrack（或 currentTrack 不在队列中）时，退化为置顶到队首
      ids.unshift(track.id)
    }

    onReorderQueue(ids)
    toast.success(`已置顶「${track.title}」`)
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction={isMobile ? 'bottom' : 'right'}>
      <DrawerContent className={cn('flex flex-col overflow-x-hidden p-0', isMobile && 'h-[70vh]')}>
        <DrawerHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <DrawerTitle className="flex items-center gap-2 text-base">
              <Music className="h-4 w-4" />
              播放列表 ({displayQueue.length})
            </DrawerTitle>
            {songLikes && (
              <button
                type="button"
                onClick={() => setSortByLikes((v) => !v)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  sortByLikes
                    ? 'bg-primary/10 text-primary hover:bg-primary/20'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Heart className="h-3 w-3" fill={sortByLikes ? 'currentColor' : 'none'} />
                {sortByLikes ? '赞序' : '队列'}
              </button>
            )}
            <div className="flex items-center gap-1">
              {canRemove && queue.length > 0 && (
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('h-7 w-7', confirmClear && 'text-destructive hover:text-destructive')}
                      onClick={handleClear}
                      aria-label="清空播放列表"
                    >
                      <ListX className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{confirmClear ? '再次点击确认清空' : '清空播放列表'}</TooltipContent>
                </Tooltip>
              )}
              {!isMobile && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onOpenChange(false)}
                  aria-label="关闭播放列表"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </DrawerHeader>

        <div ref={setScrollElement} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2">
          {displayQueue.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">播放列表为空</div>
          ) : (
            <div className="w-full" style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const i = virtualRow.index
                const track = displayQueue[i]
                if (!track) return null
                const realIndex = queue.indexOf(track)
                return (
                  <div
                    key={track.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                      paddingTop: '8px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      className={cn(
                        'group relative flex h-full items-center gap-2 rounded-lg px-2 transition-colors hover:bg-accent/50',
                        currentTrack?.id === track.id && 'bg-primary/10',
                      )}
                    onClick={() => {
                      if (isTouch) {
                        setActiveTrackId((prev) => (prev === track.id ? null : track.id))
                      }
                    }}
                    onMouseLeave={() => {
                      if (!isTouch && dismissedHoverTrackId === track.id) setDismissedHoverTrackId(null)
                    }}
                  >
                    {/* Like button + count — always visible when like mode is on, on the left */}
                    {songLikes && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className={cn(
                            'flex items-center gap-0.5 rounded px-1 py-0.5 text-xs transition-colors',
                            (trackLikes[track.id]?.includes(myId) ?? false)
                              ? 'text-red-500 hover:text-red-600'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleLikeToggle(track)
                          }}
                          aria-label={
                            (trackLikes[track.id]?.includes(myId) ?? false) ? `取消点赞 ${track.title}` : `点赞 ${track.title}`
                          }
                        >
                          <Heart
                            className="h-3.5 w-3.5"
                            fill={(trackLikes[track.id]?.includes(myId) ?? false) ? 'currentColor' : 'none'}
                          />
                          {(trackLikes[track.id]?.length ?? 0) > 0 && (
                            <span className="tabular-nums">{trackLikes[track.id]?.length}</span>
                          )}
                        </button>

                      </div>
                    )}

                    {/* Index */}
                    <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>

                    {/* Cover + source badge */}
                    <div className="relative shrink-0">
                      {track.cover ? (
                        <img
                          src={track.cover}
                          alt={track.title}
                          className="h-9 w-9 rounded object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                            e.currentTarget.nextElementSibling?.classList.remove('hidden')
                          }}
                        />
                      ) : null}
                      <div
                        className={cn(
                          'flex h-9 w-9 items-center justify-center rounded bg-muted',
                          track.cover && 'hidden',
                        )}
                      >
                        <Music className="h-4 w-4 text-muted-foreground" />
                      </div>
                      {track.source && SOURCE_STYLE[track.source] && (
                        <a
                          href={getSourceUrl(track)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            'absolute -bottom-1 -right-1 rounded px-0.5 text-[8px] font-bold leading-tight ring-1 transition-transform hover:scale-110',
                            SOURCE_STYLE[track.source].className,
                          )}
                          title={`在源平台打开 ${track.title}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {SOURCE_STYLE[track.source].label}
                        </a>
                      )}
                    </div>

                    {/* Track info */}
                    <div className="min-w-0 flex-1 overflow-hidden [contain:inline-size]">
                      <MarqueeText
                        className={cn('text-sm', currentTrack?.id === track.id && 'font-medium text-primary')}
                      >
                        {track.title}
                      </MarqueeText>
                      <MarqueeText className="text-xs text-muted-foreground">{track.artist.join(' / ')}</MarqueeText>
                    </div>

                    {/* Requester badge — in flow, after track info (avoids overlap with long titles) */}
                    {track.requestedBy && (
                      <Badge
                        variant="outline"
                        className="shrink-0 h-4 gap-0.5 border-primary/30 bg-primary/10 px-1.5 py-0 text-[10px] font-normal text-primary"
                      >
                        <User className="h-2.5 w-2.5" />
                        {track.requestedBy}
                      </Badge>
                    )}

                    {/* Actions — visible on hover (desktop) or tap (mobile) */}
                    <div
                      className={cn(
                        'absolute right-1 top-1/2 z-20 flex -translate-y-1/2 items-center gap-0.5',
                        'rounded-md border border-border/50 bg-popover px-1 py-0.5 shadow-md backdrop-blur-md',
                        'opacity-0 pointer-events-none transition-opacity',
                        'group-hover:opacity-100 group-hover:pointer-events-auto',
                        'group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
                        isTouch && activeTrackId === track.id && 'opacity-100 pointer-events-auto',
                        !isTouch && dismissedHoverTrackId === track.id && 'opacity-0 pointer-events-none',
                      )}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* External link — open in source platform */}
                      <Tooltip delayDuration={400}>
                        <TooltipTrigger asChild>
                          <a
                            href={getSourceUrl(track)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent active:scale-90 transition-all min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                            aria-label={`在源平台打开 ${track.title}`}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">在源平台打开</TooltipContent>
                      </Tooltip>

                        {/* Play button — hidden for currently playing track */}
                      {currentTrack?.id !== track.id && (canPlay || canVote) && (
                        <Tooltip delayDuration={400}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                              onClick={() => handlePlayTrack(track)}
                              aria-label={canPlay ? `播放 ${track.title}` : `投票播放 ${track.title}`}
                            >
                              <Play className="h-3 w-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{canPlay ? '播放' : '投票播放'}</TooltipContent>
                        </Tooltip>
                      )}

                      {canReorder && (
                        <>
                          <Tooltip delayDuration={400}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                                disabled={realIndex <= 0}
                                onClick={() => handleMoveUp(i)}
                                aria-label={`上移 ${track.title}`}
                              >
                                <ChevronUp className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">上移</TooltipContent>
                          </Tooltip>

                          <Tooltip delayDuration={400}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                                disabled={realIndex >= queue.length - 1}
                                onClick={() => handleMoveDown(i)}
                                aria-label={`下移 ${track.title}`}
                              >
                                <ChevronDown className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">下移</TooltipContent>
                          </Tooltip>

                          <Tooltip delayDuration={400}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                                onClick={(e) => handleInsertAfterCurrent(track, e)}
                                aria-label={`置顶 ${track.title}`}
                              >
                                <ArrowUpToLine className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">置顶到当前播放下方</TooltipContent>
                          </Tooltip>
                        </>
                      )}

                      {(canRemove || canVote) && (
                        <Tooltip delayDuration={400}>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 min-h-9 min-w-9 sm:min-h-0 sm:min-w-0 text-destructive hover:text-destructive"
                              onClick={() => handleRemoveTrack(track)}
                              aria-label={canRemove ? `移除 ${track.title}` : `投票移除 ${track.title}`}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{canRemove ? '移除' : '投票移除'}</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
