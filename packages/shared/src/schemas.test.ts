import { describe, expect, it } from 'vitest'
import { LIMITS } from './constants.js'
import type { LocalAudioState, LocalAudioUsage } from './types.js'
import type { QueueTrackInput } from './socket-types.js'
import {
  defaultQueueAddBatchSchema,
  defaultQueueAddSchema,
  localAudioAssetDeleteSchema,
  localAudioAssetUpdateSchema,
  localAudioTaskCancelSchema,
  localAudioTrackRefSchema,
  playlistQuerySchema,
  playlistSearchQuerySchema,
  queueAddBatchSchema,
  queueAddSchema,
  queueInsertAfterCurrentSchema,
  queueReorderSchema,
  roomSettingsSchema,
} from './schemas.js'

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

  it('accepts the final page so all supported 10000 tracks remain addressable', () => {
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

describe('playlistQuerySchema', () => {
  it('allows at most one 1000-track browser page per request', () => {
    expect(
      playlistQuerySchema.safeParse({
        source: 'netease',
        id: 'playlist-1',
        limit: 1000,
        offset: 9000,
        total: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      }).success,
    ).toBe(true)

    expect(
      playlistQuerySchema.safeParse({
        source: 'netease',
        id: 'playlist-1',
        limit: 1001,
      }).success,
    ).toBe(false)
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

const externalTrack = {
  id: 'queue-item-1',
  title: 'Online track',
  artist: ['Artist'],
  album: 'Album',
  duration: 180,
  cover: '',
  source: 'netease' as const,
  sourceId: 'source-1',
  urlId: 'url-1',
}

describe('local audio queue input schemas', () => {
  const localRef = { source: 'local' as const, assetId: 'asset_123-ABC' }

  it('accepts an exact local asset reference in every queue entry point', () => {
    expect(localAudioTrackRefSchema.parse(localRef)).toEqual(localRef)
    expect(queueAddSchema.parse({ track: localRef }).track).toEqual(localRef)
    expect(queueInsertAfterCurrentSchema.parse({ track: localRef }).track).toEqual(localRef)
    expect(queueAddBatchSchema.parse({ tracks: [localRef] }).tracks).toEqual([localRef])
    expect(defaultQueueAddSchema.parse({ track: localRef }).track).toEqual(localRef)
    expect(defaultQueueAddBatchSchema.parse({ tracks: [localRef] }).tracks).toEqual([localRef])
  })

  it('keeps the existing online track shape compatible', () => {
    expect(queueAddSchema.parse({ track: externalTrack }).track).toEqual(externalTrack)
    expect(defaultQueueAddSchema.parse({ track: externalTrack }).track).toEqual(externalTrack)
  })

  it('keeps mediaMid so QQ stream URLs can be resolved later', () => {
    const parsed = queueAddSchema.parse({ track: { ...externalTrack, mediaMid: 'REALMEDIA' } })
    expect(parsed.track).toMatchObject({ mediaMid: 'REALMEDIA' })
  })

  it('accepts bilibili tracks and keeps the cid for stream resolution', () => {
    const parsed = queueAddSchema.parse({
      track: {
        ...externalTrack,
        source: 'bilibili' as const,
        bilibiliCid: 123456,
        cover: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
      },
    })
    expect(parsed.track).toMatchObject({ source: 'bilibili', bilibiliCid: 123456 })
  })

  it.each([
    { source: 'local' },
    { source: 'local', assetId: '' },
    { source: 'local', assetId: '../asset' },
    { source: 'local', assetId: 'x'.repeat(101) },
  ])('rejects an invalid local reference: %j', (track) => {
    expect(queueAddSchema.safeParse({ track }).success).toBe(false)
  })

  it('rejects client-supplied local metadata, paths, and stream URLs', () => {
    const forgedLocalTrack = {
      ...localRef,
      id: 'forged-queue-item',
      title: 'Forged title',
      artist: ['Attacker'],
      album: 'Forged album',
      duration: 1,
      cover: 'https://attacker.invalid/cover.jpg',
      sourceId: localRef.assetId,
      urlId: localRef.assetId,
      streamUrl: 'https://attacker.invalid/audio.mp3',
      filePath: '../../secret',
    }

    expect(queueAddSchema.safeParse({ track: forgedLocalTrack }).success).toBe(false)
    expect(queueAddBatchSchema.safeParse({ tracks: [forgedLocalTrack] }).success).toBe(false)
    expect(defaultQueueAddSchema.safeParse({ track: forgedLocalTrack }).success).toBe(false)
    expect(defaultQueueAddBatchSchema.safeParse({ tracks: [forgedLocalTrack] }).success).toBe(false)
  })

  it('continues stripping server-owned URLs from online track input', () => {
    const parsed = queueAddSchema.parse({
      track: {
        ...externalTrack,
        streamUrl: 'https://attacker.invalid/audio.mp3',
        fallbackStreamUrl: 'https://attacker.invalid/fallback.mp3',
        localAudioAccessExpiresAt: Date.now() + 60_000,
      },
    })

    expect(parsed.track).not.toHaveProperty('streamUrl')
    expect(parsed.track).not.toHaveProperty('fallbackStreamUrl')
    expect(parsed.track).not.toHaveProperty('localAudioAccessExpiresAt')
  })
})

describe('local audio management schemas', () => {
  it('validates task cancellation IDs strictly', () => {
    expect(localAudioTaskCancelSchema.parse({ taskId: 'task_123' })).toEqual({ taskId: 'task_123' })
    expect(localAudioTaskCancelSchema.safeParse({ taskId: '../task' }).success).toBe(false)
    expect(localAudioTaskCancelSchema.safeParse({ taskId: 'task', assetId: 'extra' }).success).toBe(false)
  })

  it('accepts and trims editable metadata while requiring at least one change', () => {
    expect(
      localAudioAssetUpdateSchema.parse({
        assetId: 'asset-1',
        title: '  New title  ',
        artist: ['  Artist  '],
        album: '  Album  ',
      }),
    ).toEqual({
      assetId: 'asset-1',
      title: 'New title',
      artist: ['Artist'],
      album: 'Album',
    })

    expect(localAudioAssetUpdateSchema.safeParse({ assetId: 'asset-1' }).success).toBe(false)
    expect(localAudioAssetUpdateSchema.safeParse({ assetId: 'asset-1', title: '' }).success).toBe(false)
    expect(localAudioAssetUpdateSchema.safeParse({ assetId: 'asset-1', artist: [] }).success).toBe(false)
  })

  it('defaults asset deletion to preserving the current queue item', () => {
    expect(localAudioAssetDeleteSchema.parse({ assetId: 'asset-1' })).toEqual({
      assetId: 'asset-1',
      removeFromQueue: false,
    })
    expect(localAudioAssetDeleteSchema.parse({ assetId: 'asset-1', removeFromQueue: true })).toEqual({
      assetId: 'asset-1',
      removeFromQueue: true,
    })
  })
})

describe('local audio shared snapshot contract', () => {
  it('models quota usage and state snapshots without exposing filesystem fields', () => {
    const usage: LocalAudioUsage = {
      maxUploadBytes: 524_288_000,
      roomBytes: 10,
      roomLimitBytes: 1_073_741_824,
      serverBytes: 20,
      serverLimitBytes: 2_684_354_560,
      tempBytes: 30,
      tempLimitBytes: 1_342_177_280,
    }
    const state: LocalAudioState = { assets: [], tasks: [], usage }
    expect(state.usage.tempLimitBytes).toBeGreaterThan(state.usage.tempBytes)
    expect(state.assets).toEqual([])
    expect(state.tasks).toEqual([])
  })

  it('keeps local queue input as an asset reference at the type boundary', () => {
    const input: QueueTrackInput = { source: 'local', assetId: 'asset_123' }
    // @ts-expect-error Local metadata must be resolved by the server from assetId.
    const forged: QueueTrackInput = { source: 'local', assetId: 'asset_123', title: 'Forged' }
    expect(input).toEqual({ source: 'local', assetId: 'asset_123' })
    expect(forged).toHaveProperty('title', 'Forged')
  })
})
