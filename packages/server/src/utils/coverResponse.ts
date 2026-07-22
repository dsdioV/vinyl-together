const ALLOWED_COVER_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])

export const MAX_COVER_BYTES = 5 * 1024 * 1024

export type CoverResponseResult =
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; status: 413 | 415 | 502; error: string }

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already being rejected; ignore cancellation failures.
  }
}

/** Read a cover response without ever buffering more than the configured cap. */
export async function readCoverResponse(
  response: Response,
  maxBytes = MAX_COVER_BYTES,
): Promise<CoverResponseResult> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!ALLOWED_COVER_CONTENT_TYPES.has(contentType)) {
    await cancelBody(response)
    return { ok: false, status: 415, error: 'Unsupported upstream content type' }
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelBody(response)
      return { ok: false, status: 413, error: 'Cover image is too large' }
    }
  }

  if (!response.body) {
    return { ok: false, status: 502, error: 'Upstream response body is empty' }
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // The size limit is already enforced; ignore cancellation failures.
      }
      return { ok: false, status: 413, error: 'Cover image is too large' }
    }
    chunks.push(Buffer.from(value))
  }

  return {
    ok: true,
    buffer: Buffer.concat(chunks, totalBytes),
    contentType,
  }
}
