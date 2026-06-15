import { nanoid } from 'nanoid'
import type { VoteAction, VoteState, User } from '@music-together/shared'
import { TIMING } from '@music-together/shared'
import { logger } from '../utils/logger.js'

interface Vote {
  id: string
  roomId: string
  action: VoteAction
  initiatorId: string
  initiatorNickname: string
  votes: Record<string, boolean>
  requiredVotes: number
  totalUsers: number
  expiresAt: number
  timeoutHandle: ReturnType<typeof setTimeout>
  hostId: string
  payload?: Record<string, unknown>
}

interface CastResult {
  vote: Vote
  decided: boolean
  passed: boolean
  reason?: string
}

/** Active vote per room (at most one at a time) */
const activeVotes = new Map<string, Vote>()

/**
 * Create a new vote. Returns null if a vote is already in progress.
 * The initiator automatically votes "approve".
 */
export function createVote(
  roomId: string,
  hostId: string,
  initiator: User,
  action: VoteAction,
  totalUsers: number,
  threshold: number,
  payload?: Record<string, unknown>,
): Vote | null {
  if (activeVotes.has(roomId)) return null

  const requiredVotes = Math.max(1, Math.round(totalUsers * threshold))

  const vote: Vote = {
    id: nanoid(8),
    roomId,
    action,
    initiatorId: initiator.id,
    initiatorNickname: initiator.nickname,
    votes: { [initiator.id]: true }, // auto-approve by initiator
    requiredVotes,
    totalUsers,
    expiresAt: Date.now() + TIMING.VOTE_TIMEOUT_MS,
    timeoutHandle: null as unknown as ReturnType<typeof setTimeout>, // set by controller
    hostId,
    payload,
  }

  activeVotes.set(roomId, vote)
  logger.info(`Vote created: ${action} in room ${roomId} by ${initiator.nickname}`, { roomId })
  return vote
}

/**
 * Cast a vote. Returns the result or null if no active vote.
 */
export function castVote(roomId: string, userId: string, approve: boolean): CastResult | null {
  const vote = activeVotes.get(roomId)
  if (!vote) return null

  // Already voted
  if (userId in vote.votes) return null

  vote.votes[userId] = approve

  const approveCount = Object.values(vote.votes).filter(Boolean).length
  const rejectCount = Object.values(vote.votes).filter((v) => !v).length

  // Passed: enough approvals
  if (approveCount >= vote.requiredVotes) {
    return { vote, decided: true, passed: true }
  }

  // Mathematically impossible to pass
  if (rejectCount > vote.totalUsers - vote.requiredVotes) {
    return { vote, decided: true, passed: false, reason: 'rejected' }
  }

  // Not decided yet
  return { vote, decided: false, passed: false }
}

/**
 * Update the vote threshold when users leave during an active vote.
 * Recalculates requiredVotes based on current user count and removes
 * the departing user's vote if they had cast one.
 *
 * Returns true if the vote state was modified (caller should broadcast updated state).
 */
export function updateVoteThreshold(roomId: string, currentUserCount: number, threshold: number, departedUserId?: string): boolean {
  const vote = activeVotes.get(roomId)
  if (!vote) return false

  // Remove departed user's vote if they had cast one
  if (departedUserId && departedUserId in vote.votes) {
    delete vote.votes[departedUserId]
  }

  const newRequired = Math.max(1, Math.round(currentUserCount * threshold))
  vote.requiredVotes = newRequired
  vote.totalUsers = currentUserCount
  logger.info(`Vote threshold updated: ${newRequired} required (${currentUserCount} users)`, { roomId })
  return true
}

export function getActiveVote(roomId: string): Vote | null {
  return activeVotes.get(roomId) ?? null
}

export function cancelVote(roomId: string): void {
  const vote = activeVotes.get(roomId)
  if (vote) {
    clearTimeout(vote.timeoutHandle)
    activeVotes.delete(roomId)
  }
}

export function cleanupRoom(roomId: string): void {
  cancelVote(roomId)
}

/**
 * Force-approve an active vote (owner/admin override).
 * Returns the action that should be executed, or null if no active vote.
 */
export function forceApprove(roomId: string): { action: VoteAction; payload?: Record<string, unknown> } | null {
  const vote = activeVotes.get(roomId)
  if (!vote) return null
  const action = vote.action
  const payload = vote.payload
  cancelVote(roomId)
  return { action, payload }
}

/**
 * Force-reject an active vote (owner/admin override).
 * Returns true if there was an active vote to reject.
 */
export function forceReject(roomId: string): boolean {
  const vote = activeVotes.get(roomId)
  if (!vote) return false
  cancelVote(roomId)
  return true
}

/** Convert internal Vote to client-safe VoteState */
export function toVoteState(vote: Vote): VoteState {
  return {
    id: vote.id,
    action: vote.action,
    initiatorId: vote.initiatorId,
    initiatorNickname: vote.initiatorNickname,
    votes: { ...vote.votes },
    requiredVotes: vote.requiredVotes,
    totalUsers: vote.totalUsers,
    expiresAt: vote.expiresAt,
    payload: vote.payload,
  }
}
