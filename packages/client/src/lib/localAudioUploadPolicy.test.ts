import { describe, expect, it } from 'vitest'
import { exceedsLocalAudioUploadLimit } from './localAudioUploadPolicy'

describe('exceedsLocalAudioUploadLimit', () => {
  it('defers to the server while the deployment limit is unknown', () => {
    expect(exceedsLocalAudioUploadLimit(800 * 1024 * 1024)).toBe(false)
  })

  it('accepts a file exactly at the advertised limit', () => {
    expect(exceedsLocalAudioUploadLimit(500, 500)).toBe(false)
  })

  it('rejects a file larger than the advertised limit', () => {
    expect(exceedsLocalAudioUploadLimit(501, 500)).toBe(true)
  })
})
