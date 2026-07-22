import { describe, expect, it } from 'vitest'
import { readCoverResponse } from './coverResponse.js'

describe('readCoverResponse', () => {
  it('returns a small raster image response', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/png; charset=binary', 'Content-Length': '3' },
    })

    const result = await readCoverResponse(response, 4)

    expect(result).toEqual({
      ok: true,
      buffer: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
    })
  })

  it('rejects non-raster content without reading it as an image', async () => {
    const response = new Response('<svg></svg>', {
      headers: { 'Content-Type': 'image/svg+xml' },
    })

    await expect(readCoverResponse(response, 100)).resolves.toEqual({
      ok: false,
      status: 415,
      error: 'Unsupported upstream content type',
    })
  })

  it('rejects a declared response size above the cap', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '5' },
    })

    await expect(readCoverResponse(response, 4)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'Cover image is too large',
    })
  })

  it('stops an unbounded stream once its actual body exceeds the cap', async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      headers: { 'Content-Type': 'image/webp' },
    })

    await expect(readCoverResponse(response, 4)).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'Cover image is too large',
    })
  })
})
