import type { PlayMode, Track } from '@music-together/shared'
import { LIMITS } from '@music-together/shared'
import { roomRepo } from '../repositories/roomRepository.js'

export function addTrack(roomId: string, track: Track): boolean {
  const room = roomRepo.get(roomId)
  if (!room) return false
  if (room.queue.length >= LIMITS.QUEUE_MAX_SIZE) return false
  room.queue.push(track)
  return true
}

/**
 * Add multiple tracks at once (from playlist import).
 * Respects QUEUE_MAX_SIZE — adds as many as fit.
 * @returns Number of tracks actually added.
 */
export function addBatchTracks(roomId: string, tracks: Track[]): number {
  const room = roomRepo.get(roomId)
  if (!room) return 0
  const available = LIMITS.QUEUE_MAX_SIZE - room.queue.length
  if (available <= 0) return 0
  const toAdd = tracks.slice(0, available)
  room.queue.push(...toAdd)
  return toAdd.length
}

/**
 * Insert a new track right after the current playing track.
 * If current track is missing from the queue (edge race), insert to the front.
 */
export function insertAfterCurrent(roomId: string, track: Track): boolean {
  const room = roomRepo.get(roomId)
  if (!room) return false
  if (room.queue.length >= LIMITS.QUEUE_MAX_SIZE) return false

  const currentId = room.currentTrack?.id
  const currentIndex = currentId ? room.queue.findIndex((t) => t.id === currentId) : -1
  const insertIndex = currentIndex >= 0 ? currentIndex + 1 : 0
  room.queue.splice(insertIndex, 0, track)
  return true
}

export function removeTrack(roomId: string, trackId: string): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.queue = room.queue.filter((t) => t.id !== trackId)
  }
}

export function clearQueue(roomId: string): void {
  const room = roomRepo.get(roomId)
  if (room) {
    room.queue = []
  }
}

export function reorderTracks(roomId: string, trackIds: string[]): void {
  const room = roomRepo.get(roomId)
  if (!room) return
  if (!Array.isArray(trackIds) || trackIds.length === 0) return

  const trackMap = new Map(room.queue.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const reordered: Track[] = []
  for (const id of trackIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const track = trackMap.get(id)
    if (track) reordered.push(track)
  }
  // Append any tracks that were NOT included in trackIds (prevent accidental drops)
  for (const track of room.queue) {
    if (!seen.has(track.id)) {
      reordered.push(track)
    }
  }
  room.queue = reordered
}

/**
 * Compute the next track **index** given a known previous-current-index and
 * whether the track at that index has already been removed from the queue.
 *
 * This is a lower-level helper used by auto-remove flows where the
 * currentTrack may have been deleted from the queue before computing the
 * successor.  It avoids the `getNextTrack` trap of searching for a
 * currentTrack that is no longer in the queue (which yields -1).
 *
 * @param prevIndex       Index of the track that just finished (before removal).
 * @param prevRemoved     Whether that track was removed from the queue.
 *
 * Returns the next index in the (possibly shorter) queue, or -1 if no
 * successor exists.
 */
export function computeNextIndex(roomId: string, playMode: PlayMode, prevIndex: number, prevRemoved: boolean): number {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return -1

  const len = room.queue.length
  const mode = playMode ?? room.playMode ?? 'sequential'

  switch (mode) {
    case 'loop-one':
      // After removing the only track the queue may be empty — handled above.
      // Otherwise return the first (or prev, since it's the same track).
      return prevRemoved && prevIndex < len ? prevIndex : 0 < len ? 0 : -1

    case 'loop-all': {
      if (prevRemoved) {
        // The element that was at prevIndex+1 is now at prevIndex.
        return prevIndex < len ? prevIndex : 0
      }
      const nextIndex = prevIndex + 1
      return nextIndex < len ? nextIndex : 0
    }

    case 'shuffle': {
      if (len === 1) return 0
      // Avoid the same index — but since we may have removed it, exclude
      // prevIndex (which may now point to a different track; statistically
      // harmless to exclude it for variety).
      const exclude = prevRemoved ? -1 : prevIndex
      const candidates: number[] = []
      for (let i = 0; i < len; i++) {
        if (i !== exclude) candidates.push(i)
      }
      if (candidates.length === 0) return 0
      return candidates[Math.floor(Math.random() * candidates.length)]
    }

    case 'sequential':
    default: {
      if (prevRemoved) {
        return prevIndex < len ? prevIndex : -1
      }
      const nextIndex = prevIndex + 1
      return nextIndex < len ? nextIndex : -1
    }
  }
}

/**
 * Like-mode selector: pick the next track by popularity.
 *
 * Sorts remaining queue tracks by:
 *  1. Like count (descending)
 *  2. Last-like timestamp (ascending — earlier liked = higher priority)
 *  3. Original queue order (final deterministic tiebreaker)
 *
 * For shuffle mode, randomly picks within the highest-like group.
 * For all other modes, returns the highest-ranked track.
 */
export function getNextTrackByLikes(roomId: string, playMode?: PlayMode): Track | null {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return null

  const mode = playMode ?? room.playMode ?? 'sequential'

  // Annotate each track with like count and last-like timestamp
  const annotated = room.queue.map((t) => ({
    track: t,
    likes: room.trackLikes.get(t.id)?.size ?? 0,
    lastLikeAt: room.trackLikeTimestamps.get(t.id) ?? Infinity,
    originalIndex: room.queue.indexOf(t),
  }))

  // Sort: likes desc → lastLikeAt asc → originalIndex asc
  annotated.sort((a, b) => {
    if (b.likes !== a.likes) return b.likes - a.likes
    const tsDiff = a.lastLikeAt - b.lastLikeAt
    if (tsDiff !== 0) return tsDiff
    return a.originalIndex - b.originalIndex
  })

  if (mode === 'shuffle') {
    // Randomly pick within the highest-like group
    const maxLikes = annotated[0]?.likes ?? 0
    const topGroup = annotated.filter((t) => t.likes === maxLikes)
    const picked = topGroup[Math.floor(Math.random() * topGroup.length)]
    return picked?.track ?? null
  }

  // sequential / loop-all / loop-one: return the top-ranked track
  return annotated[0]?.track ?? null
}

/**
 * Get the next track based on the play mode.
 *
 * When like mode is active (songLikes + autoRemovePlayed), delegates to
 * getNextTrackByLikes() which overrides the normal play-mode behavior.
 *
 * - sequential: next in queue; null at end
 * - loop-all:   next in queue; wraps to first at end
 * - loop-one:   returns the current track itself
 * - shuffle:    random track from queue (excludes current; returns self if queue has 1 item)
 */
export function getNextTrack(roomId: string, playMode?: PlayMode): Track | null {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return null

  // Like mode overrides normal play-mode selection
  if (room.songLikes && room.autoRemovePlayed) {
    return getNextTrackByLikes(roomId, playMode)
  }

  const mode = playMode ?? room.playMode ?? 'sequential'

  const currentIndex = room.currentTrack ? room.queue.findIndex((t) => t.id === room.currentTrack!.id) : -1

  switch (mode) {
    case 'loop-one':
      // Replay the current track; fall back to next if current is gone
      if (room.currentTrack && currentIndex >= 0) return room.currentTrack
      return room.queue[0] ?? null

    case 'loop-all': {
      const nextIndex = currentIndex + 1
      return nextIndex < room.queue.length ? room.queue[nextIndex] : room.queue[0] // wrap to first
    }

    case 'shuffle': {
      if (room.queue.length === 1) return room.queue[0]
      // Pick a random track excluding the current one
      const candidates = room.queue.filter((_, i) => i !== currentIndex)
      return candidates[Math.floor(Math.random() * candidates.length)] ?? room.queue[0]
    }

    case 'sequential':
    default: {
      const nextIndex = currentIndex + 1
      return nextIndex < room.queue.length ? room.queue[nextIndex] : null
    }
  }
}

export function getPreviousTrack(roomId: string): Track | null {
  const room = roomRepo.get(roomId)
  if (!room || room.queue.length === 0) return null

  const currentIndex = room.currentTrack ? room.queue.findIndex((t) => t.id === room.currentTrack!.id) : -1

  // For loop-all, wrap to last track when at the beginning
  if (room.playMode === 'loop-all' && currentIndex <= 0) {
    return room.queue[room.queue.length - 1]
  }

  const prevIndex = currentIndex - 1
  return prevIndex >= 0 ? room.queue[prevIndex] : null
}
