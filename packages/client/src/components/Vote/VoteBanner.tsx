import { Button } from '@/components/ui/button'
import { getVoteActionLabel } from '@/hooks/useVote'
import { storage } from '@/lib/storage'
import { TIMING } from '@music-together/shared'
import type { VoteState } from '@music-together/shared'
import { AbilityContext } from '@/providers/AbilityProvider'
import { Check, ShieldCheck, ShieldX, X } from 'lucide-react'
import { useCallback, useContext, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'

interface VoteBannerProps {
  vote: VoteState
  onCastVote: (approve: boolean) => void
  onForceApprove?: () => void
  onForceReject?: () => void
}

export function VoteBanner({ vote, onCastVote, onForceApprove, onForceReject }: VoteBannerProps) {
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, vote.expiresAt - Date.now()))

  const myUserId = storage.getUserId()
  const hasVoted = myUserId in vote.votes
  const approveCount = Object.values(vote.votes).filter(Boolean).length
  const rejectCount = Object.values(vote.votes).filter((v) => !v).length
  const progressPercent = Math.max(0, (remainingMs / TIMING.VOTE_TIMEOUT_MS) * 100)
  const ability = useContext(AbilityContext)
  const canForce = ability?.can('manage', 'all') || ability?.can('play', 'Player')

  const handleForceApprove = useCallback(() => onForceApprove?.(), [onForceApprove])
  const handleForceReject = useCallback(() => onForceReject?.(), [onForceReject])

  useEffect(() => {
    const interval = setInterval(() => {
      const ms = Math.max(0, vote.expiresAt - Date.now())
      setRemainingMs(ms)
      if (ms <= 0) clearInterval(interval)
    }, 100)
    return () => clearInterval(interval)
  }, [vote.expiresAt])

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="w-full rounded-xl bg-white/10 px-4 py-3 backdrop-blur-md"
      >
        {/* Title */}
        <div className="mb-2 text-center text-sm font-medium text-white/90">
          <span className="text-white/60">{vote.initiatorNickname}</span> 发起投票：
          {getVoteActionLabel(vote.action, vote.payload)}
        </div>

        {/* Progress bar (time remaining) */}
        <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white/40 transition-[width] duration-100 ease-linear"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Votes count + buttons */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-white/60">
            {approveCount}/{vote.requiredVotes} 赞成
            {rejectCount > 0 && <span className="ml-2">{rejectCount} 反对</span>}
          </div>

          {!hasVoted ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 min-h-11 sm:min-h-0 gap-1 bg-green-500/20 px-3 text-xs text-green-300 hover:bg-green-500/30 hover:text-green-200"
                onClick={() => onCastVote(true)}
              >
                <Check className="h-3.5 w-3.5" />
                赞成
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 min-h-11 sm:min-h-0 gap-1 bg-red-500/20 px-3 text-xs text-red-300 hover:bg-red-500/30 hover:text-red-200"
                onClick={() => onCastVote(false)}
              >
                <X className="h-3.5 w-3.5" />
                反对
              </Button>
              {canForce && (
                <>
                  <div className="mx-1 w-px bg-white/10" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 min-h-11 sm:min-h-0 gap-1 bg-green-500/40 px-2 text-xs text-green-200 hover:bg-green-500/60 hover:text-green-100"
                    onClick={handleForceApprove}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    强制通过
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 min-h-11 sm:min-h-0 gap-1 bg-red-500/40 px-2 text-xs text-red-200 hover:bg-red-500/60 hover:text-red-100"
                    onClick={handleForceReject}
                  >
                    <ShieldX className="h-3.5 w-3.5" />
                    强制否决
                  </Button>
                </>
              )}
            </div>
          ) : (
            <span className="text-xs text-white/40">已投票</span>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
