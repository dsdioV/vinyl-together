import { useCallback, useEffect, useState } from 'react'
import { EVENTS, getVoteActionLabel, getVoteReasonLabel } from '@music-together/shared'
import type { VoteState, VoteAction } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { storage } from '@/lib/storage'
import { useSocketEvent } from './useSocketEvent'
import { toast } from 'sonner'

export function useVote() {
  const { socket } = useSocketContext()
  const [activeVote, setActiveVote] = useState<VoteState | null>(null)

  useSocketEvent(
    EVENTS.VOTE_STARTED,
    useCallback((vote: VoteState) => {
      // 若当前用户已投过票（如重连场景），不显示横幅
      const myUserId = storage.getUserId()
      if (myUserId in vote.votes) return
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
      // 立即隐藏横幅，不再遮挡播放按钮；结果通过 toast 通知
      setActiveVote(null)
    },
    [socket],
  )

  return { activeVote, startVote, castVote }
}
