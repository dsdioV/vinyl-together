import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDuration } from '@/lib/format'
import { cn, getSourceUrl } from '@/lib/utils'
import type { Track } from '@music-together/shared'
import { ArrowUpToLine, Check, ExternalLink, Music2, Plus, X } from 'lucide-react'
import { memo } from 'react'

export interface TrackListItemProps {
  track: Track
  index: number
  isAdded: boolean
  onAdd: (track: Track) => void
  onInsertAfterCurrent?: (track: Track) => void
  onArtistClick?: (artist: string) => void
  /** When provided, shows a remove button instead of add/insert buttons */
  onRemove?: (track: Track) => void
  style?: React.CSSProperties
  className?: string
}

export const TrackListItem = memo(function TrackListItem({
  track,
  index,
  isAdded,
  onAdd,
  onInsertAfterCurrent,
  onArtistClick,
  onRemove,
  style,
  className,
}: TrackListItemProps) {
  return (
    <div
      style={style}
      className={cn('group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', className)}
    >
      {/* Index */}
      <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>

      {/* Cover thumbnail */}
      {track.cover ? (
        <img src={track.cover} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">
          <Music2 className="h-4 w-4 text-muted-foreground" />
        </div>
      )}

      {/* Track info */}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{track.title}</span>
          {track.vip && (
            <span className="inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[10px] font-bold leading-none text-amber-500 ring-1 ring-amber-500/30 bg-amber-500/10">
              VIP
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {onArtistClick
            ? track.artist.map((a, ai) => (
                <span key={ai}>
                  {ai > 0 && ' / '}
                  <button
                    type="button"
                    className="hover:text-foreground hover:underline"
                    onClick={(e) => {
                      e.stopPropagation()
                      onArtistClick(a)
                    }}
                  >
                    {a}
                  </button>
                </span>
              ))
            : track.artist.join(' / ')}
          {track.album ? ` · ${track.album}` : ''}
        </p>
      </div>

      {/* Duration */}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(track.duration)}</span>

      {/* Source platform link */}
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={getSourceUrl(track)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent active:scale-90 transition-all"
            onClick={(e) => e.stopPropagation()}
            aria-label={`在源平台打开 ${track.title}`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </TooltipTrigger>
        <TooltipContent>在源平台打开</TooltipContent>
      </Tooltip>

      {/* Actions — remove button OR add/insert buttons */}
      <div className="flex shrink-0 items-center gap-1">
        {onRemove ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(track)}
                aria-label={`移除 ${track.title}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>从默认列表移除</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isAdded ? 'ghost' : 'outline'}
                  size="icon"
                  className={cn('h-8 w-8 shrink-0', isAdded && 'text-emerald-500 hover:text-emerald-500')}
                  disabled={isAdded}
                  onClick={() => onAdd(track)}
                  aria-label={isAdded ? '已添加' : `添加 ${track.title} 到播放列表`}
                >
                  {isAdded ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isAdded ? '已添加' : '添加到播放列表'}</TooltipContent>
            </Tooltip>

            {onInsertAfterCurrent && !isAdded && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => onInsertAfterCurrent(track)}
                    aria-label={`置顶 ${track.title}`}
                  >
                    <ArrowUpToLine className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>置顶到当前播放下方</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  )
})
