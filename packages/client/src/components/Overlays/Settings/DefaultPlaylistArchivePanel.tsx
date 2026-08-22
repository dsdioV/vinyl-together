import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Archive, Download, Save, Upload } from 'lucide-react'
import { LIMITS } from '@music-together/shared'
import { Button } from '@/components/ui/button'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import { useSnapshotRestore } from '@/hooks/useSnapshotRestore'
import { storage } from '@/lib/storage'
import {
  SNAPSHOT_MAX_TRACKS,
  buildSnapshotFromRoomRefs,
  downloadSnapshotFile,
  readLocalSnapshot,
  readSnapshotFile,
  writeLocalSnapshot,
  type DefaultQueueSnapshot,
} from '@/lib/defaultQueueArchive'

function formatSavedAt(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 默认歌单存档面板：把当前房间的默认播放列表原样存进浏览器（跟随用户数据），
 * 一键恢复到任意房间；JSON 文件用于备份、分享与换设备迁移。
 */
export function DefaultPlaylistArchivePanel() {
  const { socket } = useSocketContext()
  const roomId = useRoomStore((s) => s.room?.id)
  const roomRefs = useRoomStore((s) => s.room?.defaultQueue ?? [])

  const [snapshot, setSnapshot] = useState<DefaultQueueSnapshot | null>(() => readLocalSnapshot())
  const [applying, setApplying] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const restore = useSnapshotRestore()

  const refresh = useCallback(() => setSnapshot(readLocalSnapshot()), [])

  const handleSave = () => {
    const { tracks, skippedLocal } = buildSnapshotFromRoomRefs(roomRefs)
    if (tracks.length === 0) {
      if (snapshot && window.confirm('当前房间的默认列表为空。确定要清空浏览器里的存档吗？')) {
        storage.setDefaultQueueSnapshot(null)
        setSnapshot(null)
        toast.info('已清空本地存档')
      }
      return
    }
    if (tracks.length >= SNAPSHOT_MAX_TRACKS) {
      toast.info(`存档最多保留 ${SNAPSHOT_MAX_TRACKS} 首，超出部分未保存`)
    }
    writeLocalSnapshot(tracks)
    refresh()
    const parts = [`已保存 ${tracks.length} 首到浏览器存档`]
    if (skippedLocal > 0) parts.push(`${skippedLocal} 首本地音频无法跨房间使用，已跳过`)
    toast.success(parts.join('，'))
  }

  const handleRestore = async () => {
    if (!roomId || !snapshot || applying) return
    setApplying(true)
    try {
      await restore(socket, snapshot.tracks, useRoomStore.getState().room?.defaultQueue ?? [])
    } finally {
      setApplying(false)
    }
  }

  const handleImportFile = async (file: File | undefined) => {
    if (!file || !roomId) return
    let parsed
    try {
      parsed = await readSnapshotFile(file)
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    writeLocalSnapshot(parsed.tracks, parsed.savedAt ?? Date.now())
    refresh()
    const parts: string[] = [`导入 ${parsed.tracks.length} 首`]
    if (parsed.skippedInvalid > 0) parts.push(`无效 ${parsed.skippedInvalid} 条`)
    if (parsed.duplicates > 0) parts.push(`重复 ${parsed.duplicates} 条`)
    toast.success(`已更新浏览器存档：${parts.join('，')}`)

    // 在房间设置里导入的意图就是填充，直接恢复到当前房间
    setApplying(true)
    try {
      await restore(socket, parsed.tracks, useRoomStore.getState().room?.defaultQueue ?? [])
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-muted-foreground">存档</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {snapshot
            ? `已保存 ${snapshot.tracks.length} 首 · ${formatSavedAt(snapshot.savedAt)}`
            : '尚未保存，配置好默认列表后点「保存」'}
        </span>
        <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleSave}>
          <Save className="mr-1 h-3.5 w-3.5" />
          保存
        </Button>
        <Button
          size="sm"
          className="h-8 shrink-0"
          disabled={!snapshot || applying || roomRefs.length >= LIMITS.DEFAULT_QUEUE_MAX_SIZE}
          onClick={() => void handleRestore()}
        >
          恢复到本房间
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="导出存档为 JSON 文件"
          title="导出 JSON 文件（备份 / 分享 / 换设备）"
          disabled={!snapshot}
          onClick={() => snapshot && downloadSnapshotFile(snapshot)}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="从 JSON 文件导入"
          title="从 JSON 文件导入并恢复到本房间"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void handleImportFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        存档保存在本浏览器、跟随你的账号数据；换设备或分享给朋友用 JSON 文件。本地音频随房间销毁不会存档；恢复为追加模式，重复歌曲自动跳过。
      </p>
    </div>
  )
}
