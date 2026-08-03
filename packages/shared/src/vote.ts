import type { PlayMode, VoteAction } from './types.js'

export const ACTION_LABELS: Record<VoteAction, string> = {
  pause: '暂停',
  resume: '播放',
  next: '下一首',
  prev: '上一首',
  'set-mode': '切换播放模式',
  'play-track': '指定播放',
  'remove-track': '投票移除',
}

const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  sequential: '顺序播放',
  'loop-all': '列表循环',
  'loop-one': '单曲循环',
  shuffle: '随机播放',
}

/**
 * 计算让投票通过所需的最少人数：满足 approveCount / total >= threshold 的最小整数。
 * 使用 ceil 而非 round（round 会让结果低于配置阈值，如 5 人 25% 只需 1 票 = 20%）。
 * 引入极小容差避免浮点误差把恰好整除的比例（如 5×20%=1.0）错算成 2。
 */
export function requiredVoteCount(totalUsers: number, threshold: number): number {
  const raw = totalUsers * threshold
  return Math.max(1, Math.ceil(raw - 1e-9))
}

/** Get a human-readable label for a vote action, including payload context */
export function getVoteActionLabel(action: VoteAction, payload?: Record<string, unknown>): string {
  if (action === 'set-mode' && payload?.mode) {
    const modeLabel = PLAY_MODE_LABELS[payload.mode as PlayMode] ?? payload.mode
    return `切换为${modeLabel}`
  }
  if (action === 'play-track' && payload?.trackTitle) {
    return `播放「${payload.trackTitle}」`
  }
  if (action === 'remove-track' && payload?.trackTitle) {
    return `移除「${payload.trackTitle}」`
  }
  return ACTION_LABELS[action]
}

export function getVoteReasonLabel(reason?: string): string {
  switch (reason) {
    case 'host_veto':
      return '（房主否决）'
    case 'timeout':
      return '（超时）'
    case 'rejected':
      return '（被拒绝）'
    case 'force_rejected':
      return '（管理员否决）'
    case 'force_approved':
      return '（管理员强制通过）'
    default:
      return ''
  }
}
