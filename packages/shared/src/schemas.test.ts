import { describe, expect, it } from 'vitest'
import { LIMITS } from './constants.js'
import { playlistSearchQuerySchema, queueReorderSchema, roomSettingsSchema } from './schemas.js'

const baseQuery = {
  source: 'netease',
  id: 'playlist-1',
  keyword: 'needle',
}

describe('playlistSearchQuerySchema', () => {
  it('applies the fixed 50-track page defaults and trims identifiers', () => {
    expect(
      playlistSearchQuerySchema.parse({
        ...baseQuery,
        id: ' playlist-1 ',
        keyword: ' needle ',
      }),
    ).toEqual({
      ...baseQuery,
      page: 1,
      limit: LIMITS.PLAYLIST_SEARCH_PAGE_SIZE,
      type: 'playlist',
    })
  })

  it('accepts the final page so all supported 8192 tracks remain addressable', () => {
    const result = playlistSearchQuerySchema.safeParse({
      ...baseQuery,
      page: LIMITS.PLAYLIST_SEARCH_PAGE_MAX,
      limit: LIMITS.PLAYLIST_SEARCH_PAGE_SIZE,
    })

    expect(result.success).toBe(true)
  })

  it('accepts the maximum keyword and playlist ID lengths', () => {
    const result = playlistSearchQuerySchema.safeParse({
      ...baseQuery,
      id: 'i'.repeat(LIMITS.PLAYLIST_ID_MAX_LENGTH),
      keyword: 'k'.repeat(LIMITS.SEARCH_KEYWORD_MAX_LENGTH),
    })

    expect(result.success).toBe(true)
  })

  it.each([
    { page: 0 },
    { page: LIMITS.PLAYLIST_SEARCH_PAGE_MAX + 1 },
    { limit: 49 },
    { limit: 51 },
    { keyword: '   ' },
    { keyword: 'k'.repeat(LIMITS.SEARCH_KEYWORD_MAX_LENGTH + 1) },
    { id: '' },
    { id: 'i'.repeat(LIMITS.PLAYLIST_ID_MAX_LENGTH + 1) },
  ])('rejects invalid full-playlist search bounds: %j', (override) => {
    expect(playlistSearchQuerySchema.safeParse({ ...baseQuery, ...override }).success).toBe(false)
  })

  it('lets the service report an authoritative total above the supported scan limit', () => {
    const result = playlistSearchQuerySchema.safeParse({
      ...baseQuery,
      total: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1,
    })

    expect(result.success).toBe(true)
  })
})

describe('roomSettingsSchema maxQueueSize', () => {
  it('accepts the four-digit 8192 queue limit', () => {
    expect(roomSettingsSchema.safeParse({ maxQueueSize: LIMITS.QUEUE_MAX_SIZE_MAX }).success).toBe(true)
  })

  it('rejects values above the configured queue limit', () => {
    expect(roomSettingsSchema.safeParse({ maxQueueSize: LIMITS.QUEUE_MAX_SIZE_MAX + 1 }).success).toBe(false)
  })
})

describe('queueReorderSchema', () => {
  it('accepts a complete 8192-track queue order', () => {
    const trackIds = Array.from({ length: LIMITS.QUEUE_MAX_SIZE_MAX }, (_, index) => `track-${index}`)

    expect(queueReorderSchema.safeParse({ trackIds }).success).toBe(true)
  })

  it('rejects a queue order above the configured maximum', () => {
    const trackIds = Array.from({ length: LIMITS.QUEUE_MAX_SIZE_MAX + 1 }, (_, index) => `track-${index}`)

    expect(queueReorderSchema.safeParse({ trackIds }).success).toBe(false)
  })
})
