import { describe, expect, it } from 'vitest'
import {
  buildSnapshotFromRoomRefs,
  dedupeRefs,
  parseSnapshotFile,
  snapshotToJsonString,
} from './defaultQueueArchive.js'
import type { DefaultQueueTrackRef } from '@music-together/shared'

const ref = (id: string, overrides?: Partial<DefaultQueueTrackRef>): DefaultQueueTrackRef => ({
  id: `track-${id}`,
  source: 'netease',
  sourceId: `sid-${id}`,
  title: `T ${id}`,
  artist: ['A'],
  ...overrides,
})

describe('dedupeRefs', () => {
  it('dedupes by id and by source:sourceId while keeping first occurrences', () => {
    const { unique, duplicates } = dedupeRefs([
      ref('a'),
      ref('a'), // 同 id
      { ...ref('b'), id: 'track-b2', sourceId: 'sid-a' }, // 同 source:sourceId
      ref('c'),
    ])
    expect(unique.map((r) => r.id)).toEqual(['track-a', 'track-c'])
    expect(duplicates).toBe(2)
  })
})

describe('buildSnapshotFromRoomRefs', () => {
  it('excludes local assets and dedupes', () => {
    const { tracks, skippedLocal, duplicates } = buildSnapshotFromRoomRefs([
      ref('a'),
      ref('local-1', { source: 'local', assetId: 'x' }),
      ref('dup', { sourceId: 'sid-a' }),
    ])
    expect(tracks.map((r) => r.id)).toEqual(['track-a'])
    expect(skippedLocal).toBe(1)
    expect(duplicates).toBe(1)
  })
})

describe('parseSnapshotFile', () => {
  const fileJson = JSON.stringify({
    kind: 'vinyl-default-queue-snapshot',
    version: 1,
    savedAt: 1700000000000,
    tracks: [
      ref('a'),
      ref('local', { source: 'local', assetId: 'x' }), // 本地资产应剔除
      'garbage',
      { ...ref('d'), sourceId: 'sid-a' }, // 与 a 同键，判重
      ref('b'),
    ],
  })

  it('validates, excludes local refs, dedupes and reports counts', () => {
    const parsed = parseSnapshotFile(fileJson)
    expect(parsed.tracks.map((r) => r.id)).toEqual(['track-a', 'track-b'])
    expect(parsed.skippedInvalid).toBe(2)
    expect(parsed.duplicates).toBe(1)
    expect(parsed.truncated).toBe(0)
    expect(parsed.savedAt).toBe(1700000000000)
  })

  it('roundtrips through snapshotToJsonString', () => {
    const parsed = parseSnapshotFile(fileJson)
    const text = snapshotToJsonString({ savedAt: parsed.savedAt ?? 0, tracks: parsed.tracks })
    const reparsed = parseSnapshotFile(text)
    expect(reparsed.tracks).toEqual(parsed.tracks)
  })

  it('roundtrips QQ mediaMid through JSON and rejects injected values', () => {
    const qqRef = {
      ...ref('qq'),
      source: 'tencent' as const,
      sourceId: 'song-mid',
      mediaMid: '0040R1kU05kBkq',
    }
    const text = snapshotToJsonString({ savedAt: 1700000000000, tracks: [qqRef] })
    const parsed = parseSnapshotFile(text)

    expect(parsed.tracks).toEqual([qqRef])
    expect(parsed.tracks[0]?.mediaMid).toBe('0040R1kU05kBkq')

    for (const mediaMid of ['../evil', 'MID?injected=1', 'MID-MEDIA', ' '.repeat(3)]) {
      const unsafe = parseSnapshotFile(JSON.stringify({ tracks: [{ ...qqRef, mediaMid }] }))
      expect(unsafe.tracks).toHaveLength(0)
      expect(unsafe.skippedInvalid).toBe(1)
    }
  })

  it('rejects malformed input', () => {
    expect(() => parseSnapshotFile('not json')).toThrow('JSON 格式错误')
    expect(() => parseSnapshotFile(JSON.stringify({ kind: 'other' }))).toThrow('不是默认歌单存档文件')
    expect(() => parseSnapshotFile(JSON.stringify({ tracks: [] }))).toThrow('文件中没有歌曲数据')
  })

  it('accepts files without kind marker but rejects unknown kinds', () => {
    const lenient = parseSnapshotFile(JSON.stringify({ tracks: [ref('x')] }))
    expect(lenient.tracks).toHaveLength(1)
    expect(() =>
      parseSnapshotFile(JSON.stringify({ kind: 'vinyl-default-queue-snapshot', version: 1, tracks: [ref('y')] })),
    ).not.toThrow()
  })
})
