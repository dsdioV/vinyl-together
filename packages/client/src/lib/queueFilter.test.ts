import { describe, expect, it } from 'vitest'
import type { Track } from '@music-together/shared'
import { filterQueueTracks } from './queueFilter'

const makeTrack = (title: string, artist: string[]): Track => ({
  id: title,
  title,
  artist,
  album: '',
  duration: 180,
  cover: '',
  source: 'netease',
  sourceId: title,
  urlId: title,
})

describe('filterQueueTracks', () => {
  const tracks = [
    makeTrack('Still Alive', ['GLaDOS']),
    makeTrack('Wish As The Stars', ['蔚']),
    makeTrack('双模组混音', ['Void', 'FOOTCRUMBLE']),
  ]

  it('matches by title case-insensitively', () => {
    expect(filterQueueTracks(tracks, 'still alive').map((t) => t.id)).toEqual(['Still Alive'])
  })

  it('matches by any artist', () => {
    expect(filterQueueTracks(tracks, 'footcrumble').map((t) => t.id)).toEqual(['双模组混音'])
    expect(filterQueueTracks(tracks, '蔚').map((t) => t.id)).toEqual(['Wish As The Stars'])
  })

  it('returns a copy for an empty query', () => {
    const result = filterQueueTracks(tracks, '   ')
    expect(result).toEqual(tracks)
    expect(result).not.toBe(tracks)
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterQueueTracks(tracks, '不存在的歌')).toEqual([])
  })
})
