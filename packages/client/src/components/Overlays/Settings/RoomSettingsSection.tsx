import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { DefaultPlaylistSection } from './DefaultPlaylistSection'
import { storage } from '@/lib/storage'
import { usePlayerStore } from '@/stores/playerStore'
import { useRoomStore } from '@/stores/roomStore'
import { useSocketContext } from '@/providers/SocketProvider'
import type { AudioQuality } from '@music-together/shared'
import { EVENTS, LIMITS, VOTE } from '@music-together/shared'
import { Check, Copy, Lock, LockOpen, Pencil, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SettingRow } from './SettingRow'

const QUALITY_OPTIONS: { value: AudioQuality; label: string; description?: string }[] = [
  { value: 128, label: '标准 128kbps' },
  { value: 192, label: '较高 192kbps' },
  { value: 320, label: 'HQ 320kbps' },
  { value: 999, label: '无损 SQ', description: '需要 VIP 账号' },
]

function getQualityLabel(quality: AudioQuality): string {
  return QUALITY_OPTIONS.find((o) => o.value === quality)?.label ?? `${quality}kbps`
}

interface RoomSettingsSectionProps {
  onUpdateSettings: (settings: {
    name?: string
    password?: string | null
    audioQuality?: AudioQuality
    autoRemovePlayed?: boolean
    songLikes?: boolean
    voteThreshold?: number
  }) => void
}

export function RoomSettingsSection({ onUpdateSettings }: RoomSettingsSectionProps) {
  const room = useRoomStore((s) => s.room)
  const currentUser = useRoomStore((s) => s.currentUser)
  const roomPassword = useRoomStore((s) => s.roomPassword)
  const syncDrift = usePlayerStore((s) => s.syncDrift)
  const { socket } = useSocketContext()
  const isOwner = currentUser?.role === 'owner'
  const isAdmin = currentUser?.role === 'admin'

  const driftDisplay = useMemo(() => {
    const ms = Math.round(syncDrift * 1000)
    const label = ms > 0 ? `+${ms}ms` : `${ms}ms`
    const isHigh = Math.abs(ms) > 500
    return { label, isHigh }
  }, [syncDrift])
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordEnabled, setPasswordEnabled] = useState(room?.hasPassword ?? false)

  // 昵称编辑
  const [nickname, setNickname] = useState(storage.getNickname())
  const handleNicknameBlur = () => {
    const trimmed = nickname.trim()
    if (trimmed) {
      storage.setNickname(trimmed)
      toast.success('昵称已保存（下次加入房间生效）')
    }
  }

  // Room name editing state
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

  // 投票通过率 — 百分比显示（1-100），内部存储为小数 (0.01-1.0)
  const [voteThresholdPercent, setVoteThresholdPercent] = useState(
    () => Math.round((room?.voteThreshold ?? VOTE.DEFAULT_THRESHOLD) * 100),
  )
  // Sync from room when it changes (e.g. another admin updated it)
  useEffect(() => {
    if (room?.voteThreshold !== undefined) {
      setVoteThresholdPercent(Math.round(room.voteThreshold * 100))
    }
  }, [room?.voteThreshold])

  useEffect(() => {
    setPasswordEnabled(room?.hasPassword ?? false)
    setPasswordInput('')
  }, [room?.hasPassword])

  const copyRoomLink = () => {
    const url = `${window.location.origin}/room/${room?.id}`
    navigator.clipboard.writeText(url)
    toast.success('房间链接已复制')
  }

  const handlePasswordToggle = (checked: boolean) => {
    if (!checked) {
      setPasswordEnabled(false)
      setPasswordInput('')
      onUpdateSettings({ password: null })
      toast.success('密码已移除')
    } else {
      setPasswordEnabled(true)
    }
  }

  const handleSetPassword = () => {
    if (!passwordInput.trim()) {
      toast.error('请输入密码')
      return
    }
    onUpdateSettings({ password: passwordInput.trim() })
    toast.success('密码已设置')
  }

  const handleStartEditName = () => {
    setNameInput(room?.name ?? '')
    setEditingName(true)
  }

  const handleSaveName = () => {
    const trimmed = nameInput.trim()
    if (!trimmed) {
      toast.error('房间名不能为空')
      return
    }
    if (trimmed === room?.name) {
      setEditingName(false)
      return
    }
    onUpdateSettings({ name: trimmed })
    setEditingName(false)
    toast.success('房间名已更新')
  }

  const handleCancelEditName = () => {
    setEditingName(false)
    setNameInput('')
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold">房间信息</h3>
        <Separator className="mt-2 mb-4" />

        <SettingRow label="房间名">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                maxLength={LIMITS.ROOM_NAME_MAX_LENGTH}
                className="h-7 w-40 text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName()
                  if (e.key === 'Escape') handleCancelEditName()
                }}
                autoFocus
              />
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSaveName}>
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCancelEditName}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-sm">{room?.name}</span>
              {isOwner && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleStartEditName}
                  aria-label="编辑房间名"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
          )}
        </SettingRow>

        <SettingRow label="房间号">
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-0.5 text-sm">{room?.id}</code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={copyRoomLink}
                  aria-label="复制房间链接"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>复制房间链接</TooltipContent>
            </Tooltip>
          </div>
        </SettingRow>

        <SettingRow label="同步偏移">
          <span className={`text-sm font-mono ${driftDisplay.isHigh ? 'text-yellow-500' : 'text-muted-foreground'}`}>
            {driftDisplay.label}
          </span>
        </SettingRow>

        <SettingRow label="音质" description={isOwner ? '切换后对下一首歌生效' : undefined}>
          {isOwner ? (
            <Select
              value={String(room?.audioQuality ?? 320)}
              onValueChange={(v) => {
                const quality = Number(v) as AudioQuality
                onUpdateSettings({ audioQuality: quality })
                toast.success(`音质已切换为 ${getQualityLabel(quality)}`)
              }}
            >
              <SelectTrigger className="h-8 w-[145px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUALITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    <div className="flex items-center gap-2">
                      <span>{opt.label}</span>
                      {opt.description && (
                        <span className="text-[10px] text-muted-foreground">({opt.description})</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm text-muted-foreground">{getQualityLabel(room?.audioQuality ?? 320)}</span>
          )}
        </SettingRow>

        <SettingRow label="密码保护">
          {room?.hasPassword ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <Lock className="h-3 w-3" /> 已设置
              </Badge>
              {roomPassword && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code
                      className="cursor-pointer rounded bg-muted px-2 py-0.5 text-xs transition-colors hover:bg-muted/80"
                      onClick={() => {
                        navigator.clipboard.writeText(roomPassword)
                        toast.success('密码已复制')
                      }}
                    >
                      {roomPassword}
                    </code>
                  </TooltipTrigger>
                  <TooltipContent>点击复制密码</TooltipContent>
                </Tooltip>
              )}
            </div>
          ) : (
            <Badge variant="outline" className="gap-1">
              <LockOpen className="h-3 w-3" /> 无密码
            </Badge>
          )}
        </SettingRow>
      </div>

      {isOwner && (
        <div>
          <h3 className="text-base font-semibold">房主设置</h3>
          <Separator className="mt-2 mb-4" />

          <SettingRow label="房间密码" description="开启后需输入密码才能进入">
            <Switch checked={passwordEnabled} onCheckedChange={handlePasswordToggle} />
          </SettingRow>

          {passwordEnabled && (
            <div className="flex gap-2 pb-2">
              <Input
                type="password"
                placeholder="输入新密码..."
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                maxLength={LIMITS.ROOM_PASSWORD_MAX_LENGTH}
                className="flex-1"
                onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
              />
              <Button size="sm" onClick={handleSetPassword}>
                确认
              </Button>
            </div>
          )}

          <SettingRow label="播完自动移出" description="开启后每首歌播完自动从队列移除，避免少数人点歌时无限循环">
            <Switch
              checked={room?.autoRemovePlayed ?? false}
              onCheckedChange={(checked) => onUpdateSettings({ autoRemovePlayed: checked, ...(!checked ? { songLikes: false } : {}) })}
            />
          </SettingRow>

          <SettingRow
            label="点赞模式"
            description={
              room?.autoRemovePlayed
                ? '下一首将优先播放点赞数更高的歌曲'
                : '需先开启「播完自动移出」'
            }
          >
            <Switch
              checked={room?.songLikes ?? false}
              disabled={!room?.autoRemovePlayed}
              onCheckedChange={(checked) => onUpdateSettings({ songLikes: checked })}
            />
          </SettingRow>

          <SettingRow
            label="投票通过率"
            description={`当前：需要 ${Math.max(1, Math.round((room?.users.length ?? 1) * (room?.voteThreshold ?? VOTE.DEFAULT_THRESHOLD)))} / ${room?.users.length ?? 0} 人通过`}
          >
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                max={100}
                value={voteThresholdPercent}
                onChange={(e) => {
                  const raw = e.target.value
                  // Allow empty input during editing
                  if (raw === '') {
                    setVoteThresholdPercent(0)
                    return
                  }
                  const v = Number(raw)
                  if (isNaN(v)) return
                  setVoteThresholdPercent(v)
                }}
                onBlur={() => {
                  const clamped = Math.min(100, Math.max(1, voteThresholdPercent || VOTE.DEFAULT_THRESHOLD * 100))
                  setVoteThresholdPercent(clamped)
                  onUpdateSettings({ voteThreshold: clamped / 100 })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const clamped = Math.min(100, Math.max(1, voteThresholdPercent || VOTE.DEFAULT_THRESHOLD * 100))
                    setVoteThresholdPercent(clamped)
                    onUpdateSettings({ voteThreshold: clamped / 100 })
                  }
                }}
                className="h-7 w-16 text-sm text-center"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </SettingRow>

          <Separator className="mt-6 mb-4" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-destructive">删除房间</p>
              <p className="text-xs text-muted-foreground">将所有人移出并永久删除此房间（不可撤销）</p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const confirmed = window.confirm('确定要删除此房间吗？此操作不可撤销。')
                if (confirmed) {
                  socket.emit(EVENTS.ROOM_DELETE)
                }
              }}
            >
              删除房间
            </Button>
          </div>
        </div>
      )}

      {/* 默认播放列表：房主和管理员均可设置 */}
      {(isOwner || isAdmin) && (
        <div className="mt-6">
          <DefaultPlaylistSection />
        </div>
      )}

      {isAdmin && !isOwner && (
        <div>
          <h3 className="text-base font-semibold">管理员设置</h3>
          <Separator className="mt-2 mb-4" />

          <SettingRow label="播完自动移出" description="开启后每首歌播完自动从队列移除，避免少数人点歌时无限循环">
            <Switch
              checked={room?.autoRemovePlayed ?? false}
              onCheckedChange={(checked) => onUpdateSettings({ autoRemovePlayed: checked, ...(!checked ? { songLikes: false } : {}) })}
            />
          </SettingRow>

          <SettingRow
            label="点赞模式"
            description={
              room?.autoRemovePlayed
                ? '下一首将优先播放点赞数更高的歌曲'
                : '需先开启「播完自动移出」'
            }
          >
            <Switch
              checked={room?.songLikes ?? false}
              disabled={!room?.autoRemovePlayed}
              onCheckedChange={(checked) => onUpdateSettings({ songLikes: checked })}
            />
          </SettingRow>

          <SettingRow
            label="投票通过率"
            description={`当前：需要 ${Math.max(1, Math.round((room?.users.length ?? 1) * (room?.voteThreshold ?? VOTE.DEFAULT_THRESHOLD)))} / ${room?.users.length ?? 0} 人通过`}
          >
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                max={100}
                value={voteThresholdPercent}
                onChange={(e) => {
                  const raw = e.target.value
                  if (raw === '') {
                    setVoteThresholdPercent(0)
                    return
                  }
                  const v = Number(raw)
                  if (isNaN(v)) return
                  setVoteThresholdPercent(v)
                }}
                onBlur={() => {
                  const clamped = Math.min(100, Math.max(1, voteThresholdPercent || VOTE.DEFAULT_THRESHOLD * 100))
                  setVoteThresholdPercent(clamped)
                  onUpdateSettings({ voteThreshold: clamped / 100 })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const clamped = Math.min(100, Math.max(1, voteThresholdPercent || VOTE.DEFAULT_THRESHOLD * 100))
                    setVoteThresholdPercent(clamped)
                    onUpdateSettings({ voteThreshold: clamped / 100 })
                  }
                }}
                className="h-7 w-16 text-sm text-center"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </SettingRow>
        </div>
      )}

      {/* ---- 个人信息 ---- */}
      <div>
        <h3 className="text-base font-semibold">个人信息</h3>
        <Separator className="mt-2 mb-4" />

        <SettingRow label="昵称" description="修改后下次加入房间生效">
          <Input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onBlur={handleNicknameBlur}
            onKeyDown={(e) => e.key === 'Enter' && handleNicknameBlur()}
            className="w-40"
            placeholder="输入昵称..."
          />
        </SettingRow>
      </div>
    </div>
  )
}
