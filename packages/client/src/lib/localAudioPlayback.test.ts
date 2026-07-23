import { describe, expect, it } from 'vitest'
import type { LocalAudioAsset, Track } from '@music-together/shared'
import {
  getHowlSourceFormats,
  mergeLocalAudioAssetMetadata,
  shouldReloadLocalAudioOnResume,
} from './localAudioPlayback'

function localTrack(expiresAt?: number): Track {
  return {
    id: 'local-track',
    title: 'Local track',
    artist: ['Uploader'],
    album: 'Local',
    duration: 600,
    cover: '',
    source: 'local',
    sourceId: 'asset-1',
    urlId: 'asset-1',
    assetId: 'asset-1',
    streamUrl: '/stream?token=signed',
    localAudioAccessExpiresAt: expiresAt,
  }
}

describe('getHowlSourceFormats', () => {
  it('marks a lossless local primary as FLAC and its compatibility variant as MP3', () => {
    const track = { source: 'local' as const, fallbackStreamUrl: '/fallback' }
    expect(getHowlSourceFormats(track, false)).toEqual(['flac'])
    expect(getHowlSourceFormats(track, true)).toEqual(['mp3'])
  })

  it('marks a local track without a fallback as MP3', () => {
    expect(getHowlSourceFormats({ source: 'local' }, false)).toEqual(['mp3'])
  })

  it('uses the broad MP3 capability gate for an extensionless online URL', () => {
    expect(getHowlSourceFormats({ source: 'netease' }, false)).toEqual(['mp3'])
  })
})

describe('shouldReloadLocalAudioOnResume', () => {
  it('keeps a loaded URL that remains valid through the rest of the recording', () => {
    const now = 1_000_000
    const loaded = localTrack(now + 700_000)
    const refreshed = { ...localTrack(now + 86_400_000), streamUrl: '/stream?token=fresh' }

    expect(shouldReloadLocalAudioOnResume(loaded, refreshed, 60, now)).toBe(false)
  })

  it('reloads when the loaded URL may expire before playback finishes', () => {
    const now = 1_000_000
    const loaded = localTrack(now + 300_000)
    const refreshed = { ...localTrack(now + 86_400_000), streamUrl: '/stream?token=fresh' }

    expect(shouldReloadLocalAudioOnResume(loaded, refreshed, 360, now)).toBe(true)
  })

  it('uses the supplied server clock instead of a lagging client clock', () => {
    const clientNow = 1_000_000
    const serverNow = clientNow + 120_000
    const loaded = localTrack(serverNow + 60_000)
    const refreshed = { ...localTrack(serverNow + 86_400_000), streamUrl: '/stream?token=fresh' }

    expect(shouldReloadLocalAudioOnResume(loaded, refreshed, 590, clientNow)).toBe(false)
    expect(shouldReloadLocalAudioOnResume(loaded, refreshed, 590, serverNow)).toBe(true)
  })

  it('reloads legacy, missing, or mismatched local playback state', () => {
    const now = 1_000_000
    const refreshed = localTrack(now + 86_400_000)

    expect(shouldReloadLocalAudioOnResume(localTrack(), refreshed, 0, now)).toBe(true)
    expect(shouldReloadLocalAudioOnResume(null, refreshed, 0, now)).toBe(true)
    expect(shouldReloadLocalAudioOnResume({ ...localTrack(now + 86_400_000), id: 'other' }, refreshed, 0, now)).toBe(
      true,
    )
  })

  it('does not affect online tracks', () => {
    const refreshed = { ...localTrack(), source: 'netease' as const }
    expect(shouldReloadLocalAudioOnResume(null, refreshed, 0, 1_000_000)).toBe(false)
  })
})

describe('mergeLocalAudioAssetMetadata', () => {
  const asset: LocalAudioAsset = {
    assetId: 'asset-1',
    title: 'Renamed title',
    artist: ['Renamed artist'],
    album: 'Renamed album',
    duration: 601,
    cover: '/cover',
    uploadedByUserId: 'user-1',
    uploadedByNickname: 'Uploader',
    createdAt: 1,
    sizeBytes: 1024,
    audioQuality: 320,
    primaryFormat: 'mp3',
    hasFallback: false,
    codec: 'mp3',
    bitrate: 320,
    status: 'ready',
  }

  it('updates the playing asset metadata while preserving its signed playback fields', () => {
    const track = localTrack(86_400_000)
    const merged = mergeLocalAudioAssetMetadata(track, asset)

    expect(merged).toMatchObject({
      id: track.id,
      title: asset.title,
      artist: asset.artist,
      album: asset.album,
      duration: asset.duration,
      streamUrl: track.streamUrl,
      localAudioAccessExpiresAt: track.localAudioAccessExpiresAt,
    })
  })

  it('leaves unrelated tracks untouched', () => {
    const other = { ...localTrack(), assetId: 'asset-2' }
    expect(mergeLocalAudioAssetMetadata(other, asset)).toBe(other)
    expect(mergeLocalAudioAssetMetadata(null, asset)).toBeNull()
  })
})
