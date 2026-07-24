import { exceedsLocalAudioUploadLimit } from './localAudioUploadPolicy'

export const LOCAL_AUDIO_ACCEPTED_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.mp4',
  '.flac',
  '.wav',
  '.aiff',
  '.aif',
  '.ogg',
  '.oga',
  '.opus',
  '.webm',
] as const

export const LOCAL_AUDIO_ACCEPT_ATTRIBUTE = LOCAL_AUDIO_ACCEPTED_EXTENSIONS.join(',')

export type LocalAudioFileRejectionReason = 'size' | 'format'

export interface LocalAudioFileRejection {
  file: File
  reason: LocalAudioFileRejectionReason
}

export interface LocalAudioFileSelection {
  accepted: File[]
  rejected: LocalAudioFileRejection[]
}

export function formatLocalAudioBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 0; index < units.length - 1 && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index + 1]
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
}

export function isAllowedLocalAudioFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return LOCAL_AUDIO_ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))
}

/** Apply the same client-side admission rules to button and drag-and-drop input. */
export function selectLocalAudioFiles(files: Iterable<File>, maxUploadBytes?: number): LocalAudioFileSelection {
  const accepted: File[] = []
  const rejected: LocalAudioFileRejection[] = []
  for (const file of files) {
    if (exceedsLocalAudioUploadLimit(file.size, maxUploadBytes)) {
      rejected.push({ file, reason: 'size' })
      continue
    }
    if (!isAllowedLocalAudioFile(file)) {
      rejected.push({ file, reason: 'format' })
      continue
    }
    accepted.push(file)
  }
  return { accepted, rejected }
}
