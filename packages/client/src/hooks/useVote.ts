import { useCallback, useEffect, useState } from 'react'
import { EVENTS, getVoteActionLabel, getVoteReasonLabel } from '@music-together/shared'
import type { VoteState, VoteAction } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { useSocketEvent } from './useSocketEvent'
import { toast } from 'sonner'

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
    useCallback((data: { passed: boolean; action: VoteAction; reason?: string; payload?: Record<string, unknown> }) => {
      setActiveVote(null)
      const label = getVoteActionLabel(data.action, data.payload)
      if (data.passed) {
        toast.success(`投票通过：${label}`)
      } else {
        const reasonText = getVoteReasonLabel(data.reason)
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
