import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { MusicSource, MyPlatformAuth, Playlist } from '@music-together/shared'
import { ListMusic, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

interface PlaylistSectionProps {
  platform: MusicSource
  myStatus?: MyPlatformAuth
  playlists: Playlist[]
  loading: boolean
  onFetchMyPlaylists: () => void
  onSelectPlaylist: (playlist: Playlist) => void
}

function PlaylistSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg p-2">
      <Skeleton className="h-12 w-12 shrink-0 rounded-md" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  )
}

export function PlaylistSection({
  myStatus,
  playlists,
  loading,
  onFetchMyPlaylists,
  onSelectPlaylist,
}: PlaylistSectionProps) {
  const isLoggedIn = myStatus?.loggedIn ?? false

  // Pagination
  const PAGE_SIZE = 50
  const [currentPage, setCurrentPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(playlists.length / PAGE_SIZE))
  const paginatedPlaylists = useMemo(
    () => playlists.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [playlists, currentPage],
  )

  // Reset page when playlist count changes (e.g. after refresh)
  useEffect(() => {
    setCurrentPage(1)
  }, [playlists.length])

  // Auto-fetch playlists when logged in and no playlists loaded
  useEffect(() => {
    if (isLoggedIn && playlists.length === 0 && !loading) {
      onFetchMyPlaylists()
    }
  }, [isLoggedIn, playlists.length, loading, onFetchMyPlaylists])

  return (
    <div className="min-w-0 space-y-4 overflow-hidden">
      {/* My playlists */}
      {isLoggedIn && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">我的歌单</h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={onFetchMyPlaylists}
              disabled={loading}
              className="text-muted-foreground h-7 gap-1 px-2 text-xs"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>

          {loading && playlists.length === 0 ? (
            <div className="space-y-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <PlaylistSkeleton key={i} />
              ))}
            </div>
          ) : playlists.length > 0 ? (
            <>
              <div className="space-y-0.5">
                {paginatedPlaylists.map((pl) => (
                  <button
                    key={pl.id}
                    className="hover:bg-accent flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg p-2 text-left transition-colors"
                    onClick={() => onSelectPlaylist(pl)}
                  >
                    {pl.cover ? (
                      <img
                        src={pl.cover}
                        alt={pl.name}
                        className="h-12 w-12 shrink-0 rounded-md object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="bg-muted flex h-12 w-12 shrink-0 items-center justify-center rounded-md">
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
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
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
                  <span className="text-muted-foreground text-xs tabular-nums">
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
          ) : (
            <p className="text-muted-foreground py-4 text-center text-xs">暂无歌单</p>
          )}
        </div>
      )}
    </div>
  )
}
