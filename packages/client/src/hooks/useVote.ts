import { useCallback, useEffect, useState } from 'react'
import { EVENTS } from '@music-together/shared'
import type { PlayMode, VoteAction, VoteState } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { useSocketEvent } from './useSocketEvent'
import { toast } from 'sonner'

const ACTION_LABELS: Record<VoteAction, string> = {
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

export function useVote() {
  const { socket } = useSocketContext()
  const [activeVote, setActiveVote] = useState<VoteState | null>(null)

  useSocketEvent(
    EVENTS.VOTE_STARTED,
    useCallback((vote: VoteState) => {
      // 所有用户都显示投票横幅（包括发起者，以便 owner/admin 使用强制按钮）
      setActiveVote(vote)
    }, []),
  )

  useSocketEvent(
    EVENTS.VOTE_RESULT,
    useCallback((data: { passed: boolean; action: VoteAction; reason?: string }) => {
      setActiveVote(null)
      const label = ACTION_LABELS[data.action]
      if (data.passed) {
        toast.success(`投票通过：${label}`)
      } else {
        const reasonText = data.reason === 'timeout' ? '（超时）' : data.reason === 'force_rejected' ? '（管理员否决）' : data.reason === 'force_approved' ? '（管理员强制通过）' : ''
        toast.error(`投票未通过：${label}${reasonText}`)
      }
    }, []),
  )

  // Clear active vote on disconnect
  useEffect(() => {
    const onDisconnect = () => setActiveVote(null)
    socket.on('disconnect', onDisconnect)
    return () => {
      socket.off('disconnect', onDisconnect)
    }
  }, [socket])

  const startVote = useCallback(
    (action: VoteAction, payload?: Record<string, unknown>) => {
      socket.emit(EVENTS.VOTE_START, { action, payload })
      toast.info(`已发起投票：${getVoteActionLabel(action, payload)}`)
    },
    [socket],
  )

  const castVote = useCallback(
    (approve: boolean) => {
      socket.emit(EVENTS.VOTE_CAST, { approve })
      // 不自动隐藏横幅，让用户手动关闭（方便 owner/admin 使用强制按钮）
    },
    [socket],
  )

  const forceApprove = useCallback(() => {
    socket.emit(EVENTS.VOTE_FORCE_APPROVE)
  }, [socket])

  const forceReject = useCallback(() => {
    socket.emit(EVENTS.VOTE_FORCE_REJECT)
  }, [socket])

  const dismissVote = useCallback(() => {
    setActiveVote(null)
  }, [])

  return { activeVote, startVote, castVote, forceApprove, forceReject, dismissVote }
}
