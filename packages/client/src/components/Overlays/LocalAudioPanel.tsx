import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn, resolveLocalAudioMediaUrl } from '@/lib/utils'
import { formatDuration } from '@/lib/format'
import { formatLocalAudioBytes, LOCAL_AUDIO_ACCEPT_ATTRIBUTE } from '@/lib/localAudioFiles'
import {
  cancelLocalAudioTask,
  isLocalAudioTerminal,
  localAudioStatusLabel,
  localAudioStatusProgress,
} from '@/lib/localAudioProtocol'
import { abortActiveLocalAudioUpload } from '@/hooks/room/useLocalAudioSync'
import { useLocalAudioFileQueue } from '@/hooks/useLocalAudioFileQueue'
import { getVisibleLocalAudioTasks, useLocalAudioStore, type LocalAudioClientTask } from '@/stores/localAudioStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { EVENTS, type LocalAudioAsset } from '@music-together/shared'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Check, FileAudio, Loader2, Music2, Pencil, Plus, Search, Trash2, Upload, X, ListPlus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

function formatAssetMeta(asset: LocalAudioAsset): string {
  const artists = asset.artist.length > 0 ? asset.artist.join(' / ') : '未知艺术家'
  const duration = asset.duration > 0 ? formatDuration(asset.duration) : '--:--'
  const bitrate = asset.bitrate ? ` · ${asset.bitrate} kbps` : ''
  const output =
    asset.primaryFormat === 'flac' && asset.hasFallback ? 'FLAC · MP3 兼容' : asset.primaryFormat.toUpperCase()
  return `${artists} · ${duration} · ${output}${bitrate} · ${formatLocalAudioBytes(asset.sizeBytes)}`
}

interface LocalAudioAssetRowProps {
  asset: LocalAudioAsset
  canManage: boolean
  canEdit: boolean
  canAddDefault: boolean
  onAdd: (assetId: string) => void
  onInsert: (assetId: string) => void
  onAddDefault: (assetId: string) => void
  onEdit: (assetId: string, title: string, artist: string, album: string) => void
  onDelete: (asset: LocalAudioAsset) => void
}

function LocalAudioAssetRow({
  asset,
  canManage,
  canEdit,
  canAddDefault,
  onAdd,
  onInsert,
  onAddDefault,
  onEdit,
  onDelete,
}: LocalAudioAssetRowProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(asset.title)
  const [artist, setArtist] = useState(asset.artist.join(' / '))
  const [album, setAlbum] = useState(asset.album)
  const isPendingDelete = asset.status === 'pending-delete'

  const startEditing = () => {
    setTitle(asset.title)
    setArtist(asset.artist.join(' / '))
    setAlbum(asset.album)
    setEditing(true)
  }

  const saveEditing = () => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      toast.error('歌曲标题不能为空')
      return
    }
    if (!artist.split('/').some((item) => item.trim())) {
      toast.error('艺术家不能为空')
      return
    }
    onEdit(asset.assetId, nextTitle, artist, album)
    setEditing(false)
  }

  return (
    <div className={cn('border-b px-2 py-2 last:border-b-0', isPendingDelete && 'opacity-60')}>
      {editing ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-8 text-sm"
              aria-label="歌曲标题"
            />
            <div className="flex gap-1.5">
              <Input
                value={artist}
                onChange={(event) => setArtist(event.target.value)}
                className="h-7 min-w-0 flex-1 text-xs"
                aria-label="艺术家"
              />
              <Input
                value={album}
                onChange={(event) => setAlbum(event.target.value)}
                className="h-7 min-w-0 flex-1 text-xs"
                aria-label="专辑"
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={saveEditing} aria-label="保存编辑">
                  <Check className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>保存</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setEditing(false)}
                  aria-label="取消编辑"
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>取消</TooltipContent>
            </Tooltip>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {asset.cover ? (
            <img
              src={resolveLocalAudioMediaUrl(asset.cover)}
              alt=""
              className="h-10 w-10 shrink-0 rounded object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">
              <Music2 className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{asset.title}</p>
            <p className="truncate text-xs text-muted-foreground">{formatAssetMeta(asset)}</p>
            <p className="truncate text-[10px] text-muted-foreground/70">
              上传者：{asset.uploadedByNickname || '未知用户'}
            </p>
          </div>
          <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-flex">
            本地
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {!isPendingDelete && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onAdd(asset.assetId)}
                      aria-label={`添加 ${asset.title}`}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>加入播放列表</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => onInsert(asset.assetId)}
                      aria-label={`置顶 ${asset.title}`}
                    >
                      <ListPlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>置顶到当前播放下方</TooltipContent>
                </Tooltip>
                {canAddDefault && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onAddDefault(asset.assetId)}
                        aria-label={`加入默认列表 ${asset.title}`}
                      >
                        <FileAudio className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>加入默认列表</TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
            {canEdit && !isPendingDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={startEditing}
                    aria-label={`编辑 ${asset.title}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>编辑信息</TooltipContent>
              </Tooltip>
            )}
            {canManage && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => onDelete(asset)}
                    aria-label={`删除 ${asset.title}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>删除文件</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TaskRow({
  task,
  canCancel,
  onCancel,
}: {
  task: LocalAudioClientTask
  canCancel: boolean
  onCancel: (task: LocalAudioClientTask) => void
}) {
  const progress = localAudioStatusProgress(task)
  const terminal = isLocalAudioTerminal(task.stage)
  return (
    <div className="border-b px-2 py-2 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <Upload className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', !terminal && 'animate-pulse')} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{task.originalFileName}</p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{task.cancelling ? '正在取消' : localAudioStatusLabel(task.stage)}</span>
            {progress !== null && <span className="tabular-nums">{Math.round(progress)}%</span>}
            {task.errorMessage && <span className="truncate text-destructive">{task.errorMessage}</span>}
          </div>
          {progress !== null && !terminal && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
        {!terminal && canCancel && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => onCancel(task)}
                disabled={task.cancelling}
                aria-label={`取消 ${task.originalFileName}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>取消任务</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export function LocalAudioPanel() {
  const { socket } = useSocketContext()
  const currentUser = useRoomStore((state) => state.currentUser)
  const room = useRoomStore((state) => state.room)
  const roomId = room?.id ?? null
  const assets = useLocalAudioStore((state) => state.assets)
  const tasks = useLocalAudioStore((state) => state.tasks)
  const usage = useLocalAudioStore((state) => state.usage)
  const loading = useLocalAudioStore((state) => state.loading)
  const error = useLocalAudioStore((state) => state.error)
  const addToQueue = useLocalAudioStore((state) => state.addToQueueAfterUpload)
  const setAddToQueue = useLocalAudioStore((state) => state.setAddToQueueAfterUpload)
  const updateTask = useLocalAudioStore((state) => state.updateTask)
  const setError = useLocalAudioStore((state) => state.setError)
  const enqueueLocalAudioFiles = useLocalAudioFileQueue()
  const inputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<'recent' | 'title' | 'duration' | 'size'>('recent')
  const [deleteTarget, setDeleteTarget] = useState<LocalAudioAsset | null>(null)
  const [removeFromQueue, setRemoveFromQueue] = useState(false)
  const maxUploadBytes = usage?.maxUploadBytes

  const role = currentUser?.role ?? 'member'
  const canManageAll = role === 'owner' || role === 'admin'
  const canAddDefault = role === 'owner' || role === 'admin'
  const activeTasks = tasks.filter((task) => !isLocalAudioTerminal(task.stage))
  const visibleTasks = useMemo(() => getVisibleLocalAudioTasks(tasks), [tasks])
  const filteredAssets = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    const filtered = query
      ? assets.filter((asset) => {
          const haystack =
            `${asset.title} ${asset.artist.join(' ')} ${asset.album} ${asset.uploadedByNickname}`.toLocaleLowerCase()
          return haystack.includes(query)
        })
      : [...assets]
    filtered.sort((a, b) => {
      switch (sortMode) {
        case 'title':
          return a.title.localeCompare(b.title, 'zh-Hans') || b.createdAt - a.createdAt
        case 'duration':
          return b.duration - a.duration || b.createdAt - a.createdAt
        case 'size':
          return b.sizeBytes - a.sizeBytes || b.createdAt - a.createdAt
        case 'recent':
        default:
          return b.createdAt - a.createdAt
      }
    })
    return filtered
  }, [assets, search, sortMode])

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return
    enqueueLocalAudioFiles(fileList)
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleCancel = (task: LocalAudioClientTask) => {
    const stoppedBrowserUpload = abortActiveLocalAudioUpload(task.taskId)
    if (stoppedBrowserUpload || task.localOnly) {
      // The upload runner owns cancellation of an active server task once its
      // generated id is known. A queued browser-only task has no server state.
      updateTask(task.taskId, { stage: 'cancelled', errorMessage: '已取消', file: undefined })
      return
    }
    if (!roomId) return

    updateTask(task.taskId, { cancelling: true })
    void cancelLocalAudioTask(roomId, task.taskId)
      .then(() => {
        updateTask(task.taskId, { stage: 'cancelled', errorMessage: '已取消', file: undefined, cancelling: false })
      })
      .catch((error) => {
        updateTask(task.taskId, { cancelling: false })
        toast.error(error instanceof Error ? error.message : `「${task.originalFileName}」取消失败`)
      })
  }

  const localRef = (assetId: string) => ({ source: 'local' as const, assetId })
  const handleAdd = (assetId: string) => socket.emit(EVENTS.QUEUE_ADD, { track: localRef(assetId) })
  const handleInsert = (assetId: string) => socket.emit(EVENTS.QUEUE_INSERT_AFTER_CURRENT, { track: localRef(assetId) })
  const handleAddDefault = (assetId: string) => socket.emit(EVENTS.DEFAULT_QUEUE_ADD, { track: localRef(assetId) })

  const handleEdit = (assetId: string, title: string, artist: string, album: string) => {
    socket.emit(EVENTS.LOCAL_AUDIO_ASSET_UPDATE, {
      assetId,
      title,
      artist: artist
        .split('/')
        .map((item) => item.trim())
        .filter(Boolean),
      album: album.trim(),
    })
  }

  const handleDelete = (asset: LocalAudioAsset) => {
    setRemoveFromQueue(false)
    setDeleteTarget(asset)
  }

  const confirmDelete = () => {
    if (!deleteTarget) return
    socket.emit(EVENTS.LOCAL_AUDIO_ASSET_DELETE, {
      assetId: deleteTarget.assetId,
      removeFromQueue,
    })
    setDeleteTarget(null)
    setRemoveFromQueue(false)
  }

  const usageLabel =
    usage?.roomBytes !== undefined && usage.roomLimitBytes
      ? `${formatLocalAudioBytes(usage.roomBytes)} / ${formatLocalAudioBytes(usage.roomLimitBytes)}`
      : null
  const usagePercent =
    usage?.roomBytes !== undefined && usage.roomLimitBytes
      ? Math.min(100, (usage.roomBytes / usage.roomLimitBytes) * 100)
      : null
  const deletingCurrent = Boolean(deleteTarget && room?.currentTrack?.assetId === deleteTarget.assetId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">房间本地音乐</p>
          <p className="text-xs text-muted-foreground">上传后由服务器统一转码，房间成员可以共同收听</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={addToQueue} onChange={(event) => setAddToQueue(event.target.checked)} />
            完成后加入队列
          </label>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={LOCAL_AUDIO_ACCEPT_ATTRIBUTE}
            className="sr-only"
            onChange={(event) => handleFiles(event.target.files)}
          />
          <Button size="sm" className="gap-1.5" onClick={() => inputRef.current?.click()} disabled={!roomId}>
            <Upload className="h-3.5 w-3.5" />
            选择文件
          </Button>
        </div>
      </div>

      {usageLabel && (
        <div className="shrink-0 rounded-md border px-2.5 py-2">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>房间存储</span>
            <span className="tabular-nums">{usageLabel}</span>
          </div>
          {usagePercent !== null && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full bg-primary', usagePercent > 90 && 'bg-destructive')}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {visibleTasks.length > 0 && (
        <div className="max-h-56 min-h-0 shrink-0 overflow-y-auto rounded-md border">
          <div className="flex items-center justify-between border-b px-2.5 py-1.5">
            <span className="text-xs font-medium">上传任务 ({activeTasks.length} 进行中)</span>
            {activeTasks.some((task) => task.stage === 'transcoding' || task.stage === 'probing') && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          {visibleTasks.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              canCancel={canManageAll || task.uploadedByUserId === currentUser?.id}
              onCancel={handleCancel}
            />
          ))}
        </div>
      )}

      <div className="flex shrink-0 gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索房间音乐…"
            aria-label="搜索房间音乐"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select value={sortMode} onValueChange={(value) => setSortMode(value as typeof sortMode)}>
          <SelectTrigger size="sm" className="w-[106px] shrink-0 text-xs" aria-label="排序本地音乐">
            <SelectValue placeholder="排序" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">最近上传</SelectItem>
            <SelectItem value="title">标题</SelectItem>
            <SelectItem value="duration">时长</SelectItem>
            <SelectItem value="size">文件大小</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {loading && assets.length === 0 ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error && assets.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null)
                socket.emit(EVENTS.LOCAL_AUDIO_STATE_REQUEST)
              }}
            >
              重试
            </Button>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Music2 className="h-7 w-7" />
            <span className="text-sm">{assets.length > 0 ? '没有匹配的歌曲' : '还没有本地音乐'}</span>
          </div>
        ) : (
          filteredAssets.map((asset) => {
            const canManage = canManageAll || asset.uploadedByUserId === currentUser?.id
            const canEdit = canManage
            return (
              <LocalAudioAssetRow
                key={asset.assetId}
                asset={asset}
                canManage={canManage}
                canEdit={canEdit}
                canAddDefault={canAddDefault}
                onAdd={handleAdd}
                onInsert={handleInsert}
                onAddDefault={handleAddDefault}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            )
          })
        )}
      </div>
      <p className="shrink-0 text-[10px] text-muted-foreground">
        支持 MP3、M4A/MP4 (AAC/ALAC)、FLAC、PCM/Float WAV、PCM/Float AIFF、Ogg/WebM (Vorbis/Opus)；单文件上限{' '}
        {maxUploadBytes === undefined ? '以服务器配置为准' : formatLocalAudioBytes(maxUploadBytes)}。
      </p>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setRemoveFromQueue(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除本地音频</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `「${deleteTarget.title}」将从房间资产中删除，并清理播放队列中尚未播放的项、默认列表和点歌历史中的对应引用。`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {deletingCurrent && (
            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={removeFromQueue}
                onChange={(event) => setRemoveFromQueue(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">立即停止并切换到下一首</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  勾选后会移除正在播放的这一项，并立即清理文件。
                </span>
              </span>
            </label>
          )}
          {!removeFromQueue && deletingCurrent && (
            <p className="text-xs text-muted-foreground">当前播放不会中断，文件会在切换歌曲后清理。</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              删除文件
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
