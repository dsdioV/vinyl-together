/**
 * The server is authoritative for upload limits. Only reject in the browser
 * after a room snapshot has supplied a finite deployment-specific limit.
 */
export function exceedsLocalAudioUploadLimit(fileSize: number, maxUploadBytes?: number): boolean {
  return (
    typeof maxUploadBytes === 'number' &&
    Number.isFinite(maxUploadBytes) &&
    maxUploadBytes >= 0 &&
    fileSize > maxUploadBytes
  )
}
