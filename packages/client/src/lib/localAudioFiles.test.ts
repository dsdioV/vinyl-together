import { describe, expect, it } from 'vitest'
import {
  formatLocalAudioBytes,
  isAllowedLocalAudioFile,
  LOCAL_AUDIO_ACCEPT_ATTRIBUTE,
  selectLocalAudioFiles,
} from './localAudioFiles'

function file(name: string, size = 4): File {
  return new File([new Uint8Array(size)], name)
}

describe('local audio file admission', () => {
  it('accepts supported extensions case-insensitively', () => {
    expect(isAllowedLocalAudioFile(file('recording.FLAC'))).toBe(true)
    expect(isAllowedLocalAudioFile(file('recording.mid'))).toBe(false)
    expect(LOCAL_AUDIO_ACCEPT_ATTRIBUTE).toContain('.mp3')
  })

  it('preserves the original order while rejecting unsupported files', () => {
    const first = file('first.mp3')
    const unsupported = file('notes.txt')
    const second = file('second.wav')

    const selection = selectLocalAudioFiles([first, unsupported, second], 100)

    expect(selection.accepted).toEqual([first, second])
    expect(selection.rejected).toEqual([{ file: unsupported, reason: 'format' }])
  })

  it('uses the advertised size limit without inventing a fallback', () => {
    const atLimit = file('at-limit.mp3', 5)
    const overLimit = file('over-limit.mp3', 6)

    expect(selectLocalAudioFiles([atLimit, overLimit], 5)).toEqual({
      accepted: [atLimit],
      rejected: [{ file: overLimit, reason: 'size' }],
    })
    expect(selectLocalAudioFiles([overLimit])).toEqual({ accepted: [overLimit], rejected: [] })
  })

  it('formats limits consistently for upload errors and storage usage', () => {
    expect(formatLocalAudioBytes(500 * 1024 * 1024)).toBe('500 MiB')
  })
})
