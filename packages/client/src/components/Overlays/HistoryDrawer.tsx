import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, getSourceUrl } from '@/lib/utils'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import type { PlayedTrack, Track } from '@music-together/shared'
import { EVENTS } from '@music-together/shared'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useCallback, useContext, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AbilityContext } from '@/providers/AbilityProvider'
import { Clock, ExternalLink, Music, Plus, User, X } from 'lucide-react'
import { toast } from 'sonner'
import { MarqueeText } from '@/components/ui/marquee-text'
import type { MusicSource } from '@music-together/shared'

const EMPTY_HISTORY: PlayedTrack[] = []

const SOURCE_STYLE: Record<MusicSource, { label: string; className: string }> = {
  netease: { label: '网易', className: 'text-white bg-red-500 ring-red-600/50' },
  tencent: { label: 'QQ', className: 'text-white bg-green-500 ring-green-600/50' },
  kugou: { label: '酷狗', className: 'text-white bg-blue-500 ring-blue-600/50' },
}

interface HistoryDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Format a timestamp as a relative or absolute time string */
function formatPlayedAt(ts: number): string {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  // Fallback to date
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

export function HistoryDrawer({ open, onOpenChange }: HistoryDrawerProps) {
  const playedHistory = useRoomStore((s) => s.room?.playedHistory ?? EMPTY_HISTORY)
  const currentTrack = useRoomStore((s) => s.room?.currentTrack)
  const { socket } = useSocketContext()
  const isMobile = useIsMobile()
  const ability = useContext(AbilityContext)
  const canAdd = ability.can('add', 'Queue')

  // Reversed: newest first
  const sortedHistory = useCallback(() => {
    return [...playedHistory].sort((a, b) => b.playedAt - a.playedAt)
  }, [playedHistory])

  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  const historyList = sortedHistory()
  const virtualizer = useVirtualizer({
    count: historyList.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 64,
    overscan: 5,
  })

  const handleReAdd = useCallback(
    (entry: PlayedTrack) => {
      if (!canAdd) return
      const track: Track = { ...entry.track, streamUrl: undefined }
      socket.emit(EVENTS.QUEUE_ADD, { track })
      toast.success(`已重新点歌「${track.title}」`)
    },
    [socket, canAdd],
  )

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction={isMobile ? 'bottom' : 'right'}>
      <DrawerContent className={cn('flex flex-col overflow-x-hidden p-0', isMobile && 'h-[70vh]')}>
        <DrawerHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <DrawerTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" />
              点歌历史 ({playedHistory.length})
            </DrawerTitle>
            <div className="flex items-center gap-1">
              {!isMobile && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onOpenChange(false)}
                  aria-label="关闭历史记录"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </DrawerHeader>

        <div ref={setScrollElement} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2">
          {historyList.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">暂无点歌记录</div>
          ) : (
            <div className="w-full" style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const i = virtualRow.index
                const entry = historyList[i]
                if (!entry) return null
                const track = entry.track
                const isCurrent = currentTrack?.id === track.id

                return (
                  <div
                    key={`${track.id}-${entry.playedAt}`}
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
                        isCurrent && 'bg-primary/10',
                      )}
                    >
                      {/* Index */}
                      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>

                      {/* Cover + source badge */}
                      <div className="relative shrink-0">
                        {track.cover ? (
                          <img
                            src={track.cover}
                            alt={track.title}
                            className="h-10 w-10 rounded object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'
                              e.currentTarget.nextElementSibling?.classList.remove('hidden')
                            }}
                          />
                        ) : null}
                        <div
                          className={cn(
                            'flex h-10 w-10 items-center justify-center rounded bg-muted',
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
                          className={cn('text-sm', isCurrent && 'font-medium text-primary')}
                        >
                          {track.title}
                        </MarqueeText>
                        <div className="flex items-center gap-1.5">
                          <MarqueeText className="text-xs text-muted-foreground">
                            {track.artist.join(' / ')}
                          </MarqueeText>
                          <span className="shrink-0 text-[10px] text-muted-foreground/60">·</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                            {formatPlayedAt(entry.playedAt)}
                          </span>
                        </div>
                      </div>

                      {/* Requester badge */}
                      {entry.requestedBy && (
                        <Badge
                          variant="outline"
                          className="shrink-0 h-4 gap-0.5 border-primary/30 bg-primary/10 px-1.5 py-0 text-[10px] font-normal text-primary"
                        >
                          <User className="h-2.5 w-2.5" />
                          {entry.requestedBy}
                        </Badge>
                      )}

                      {/* Actions */}
                      <div className="flex shrink-0 items-center gap-0.5">
                        {/* External link */}
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

                        {/* Re-add to queue */}
                        {canAdd && (
                          <Tooltip delayDuration={400}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 min-h-9 min-w-9 sm:min-h-0 sm:min-w-0"
                                onClick={() => handleReAdd(entry)}
                                aria-label={`重新点歌 ${track.title}`}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">重新点歌</TooltipContent>
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
