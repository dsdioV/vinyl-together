import type { LocalAudioAsset, Track } from '@music-together/shared'

const ACCESS_REFRESH_MARGIN_MS = 60_000

/**
 * Howler pairs `format[n]` with `src[n]`; it does not treat the array as a
 * list of codec fallbacks. Local media has exactly one signed URL, so report
 * the format of the selected server-generated variant explicitly.
 */
export function getHowlSourceFormats(
  track: Pick<Track, 'source' | 'fallbackStreamUrl'>,
  usingFallback: boolean,
): string[] {
  if (track.source === 'local') {
    return [usingFallback ? 'mp3' : track.fallbackStreamUrl ? 'flac' : 'mp3']
  }
  // Online providers also expose a single extensionless URL. `format` only
  // gates whether Howler selects that URL; HTMLAudio determines the actual
  // codec from the response. MP3 is the broadest safe capability gate and
  // avoids rejecting the URL solely because a WebView lacks FLAC support.
  return ['mp3']
}

/**
 * Decide whether resume must replace the loaded Howl with a freshly signed
 * local track. The URL must remain valid for the rest of the recording, not
 * merely at the instant playback resumes.
 */
export function shouldReloadLocalAudioOnResume(
  loadedTrack: Track | null,
  refreshedTrack: Track,
  currentTime: number,
  now = Date.now(),
): boolean {
  if (refreshedTrack.source !== 'local') return false
  if (loadedTrack?.source !== 'local' || loadedTrack.id !== refreshedTrack.id || !loadedTrack.streamUrl) return true

  const expiresAt = loadedTrack.localAudioAccessExpiresAt
  if (!Number.isSafeInteger(expiresAt)) return true

  const duration = Number.isFinite(refreshedTrack.duration) ? Math.max(0, refreshedTrack.duration) : 0
  const position = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0
  const remainingMs = Math.max(0, duration - position) * 1000
  return (expiresAt as number) <= now + remainingMs + ACCESS_REFRESH_MARGIN_MS
}

/** Apply editable asset metadata without replacing playback URLs or identity. */
export function mergeLocalAudioAssetMetadata(currentTrack: Track | null, asset: LocalAudioAsset): Track | null {
  if (currentTrack?.source !== 'local' || currentTrack.assetId !== asset.assetId) return currentTrack
  return {
    ...currentTrack,
    title: asset.title,
    artist: asset.artist,
    album: asset.album,
    duration: asset.duration,
  }
}
