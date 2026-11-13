import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { MusicSource, MyPlatformAuth, PlatformAuthStatus } from '@music-together/shared'
import { AlertTriangle, Crown, KeyRound, Loader2, LogOut, ScanLine } from 'lucide-react'

const VIP_LABELS: Record<number, string> = {
  0: '',
  // Netease: 1=VIP, 10/11=黑胶VIP
  1: 'VIP',
  10: '黑胶VIP',
  11: '黑胶VIP',
  // Kugou: vip_type values
  2: '豪华VIP',
  3: '超级VIP',
}

interface LoginSectionProps {
  platform: MusicSource
  status?: PlatformAuthStatus
  myStatus?: MyPlatformAuth
  /** localStorage has a cookie for this platform but server hasn't confirmed yet */
  isVerifying?: boolean
  onQrLogin: () => void
  onCookieLogin: () => void
  onLogout: () => void
}

export function LoginSection({
  platform,
  status,
  myStatus,
  isVerifying,
  onQrLogin,
  onCookieLogin,
  onLogout,
}: LoginSectionProps) {
  const loggedInCount = status?.loggedInCount ?? 0
  const hasVip = status?.hasVip ?? false
  const maxVipType = status?.maxVipType ?? 0
  const isMyLoggedIn = myStatus?.loggedIn ?? false
  /**
   * 凭证已被上游明确判定过期（凭证未入池，因此 loggedIn 为 false）。
   * 必须与「未登录」区分：用户以为自己登录着，实际是 musickey 到期了。
   * 这正是「登录了却没有 VIP 徽章、点 VIP 歌必失败」那个 bug 的表象，
   * 不显示出来用户永远不知道该重新扫码。
   */
  const isExpired = !isMyLoggedIn && (myStatus?.expired ?? false)
  /** 已登录但上游未能确认凭证（网络/风控），提示用户可能需要重新登录。 */
  const isUnverified = isMyLoggedIn && myStatus?.credentialVerified === false

  return (
    <div className="flex items-center justify-between gap-2 overflow-hidden rounded-lg border p-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {isExpired ? (
            <span className="text-destructive truncate text-sm font-medium">登录已过期</span>
          ) : isMyLoggedIn && myStatus?.nickname ? (
            <span className="truncate text-sm font-medium">{myStatus.nickname}</span>
          ) : isVerifying ? (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              验证登录中…
            </span>
          ) : (
            <span className="text-muted-foreground shrink-0 text-sm">未登录</span>
          )}
          {isExpired ? (
            <Badge variant="outline" className="text-destructive shrink-0 gap-1 text-xs">
              <AlertTriangle className="h-3 w-3" />
              需重新扫码
            </Badge>
          ) : null}
          {hasVip && (
            <Badge variant="secondary" className="shrink-0 gap-1 text-xs">
              <Crown className="h-3 w-3" />
              {VIP_LABELS[maxVipType] || 'VIP'}
            </Badge>
          )}
          {isUnverified && (
            <Badge variant="outline" className="text-muted-foreground shrink-0 gap-1 text-xs">
              状态待确认
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {isExpired
            ? '登录凭证已失效，重新扫码即可恢复 VIP 播放'
            : isUnverified
              ? `已登录，但凭证状态未能确认${hasVip ? '，VIP 可用' : ''}`
              : loggedInCount > 0
                ? `房间内 ${loggedInCount} 人已登录${hasVip ? '，VIP 可用' : ''}`
                : '房间暂无人登录此平台'}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {isExpired ? (
          <>
            <Button variant="default" size="sm" className="h-8 gap-1.5 px-2.5" onClick={onQrLogin}>
              <ScanLine className="h-3.5 w-3.5" />
              重新扫码
            </Button>
            <Button variant="ghost" size="icon" className="text-destructive h-8 w-8" onClick={onLogout} title="清除失效凭证">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : !isMyLoggedIn && !isVerifying ? (
          <>
            {(platform === 'netease' || platform === 'kugou' || platform === 'tencent') && (
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={onQrLogin} title="扫码登录">
                <ScanLine className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={onCookieLogin} title="Cookie 登录">
              <KeyRound className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : isMyLoggedIn ? (
          <Button variant="ghost" size="icon" className="text-destructive h-8 w-8" onClick={onLogout} title="登出">
            <LogOut className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
