import { describe, expect, it, vi } from 'vitest'
import { isKugouShortCode, KugouShortCodeError, resolveKugouShortCode } from './kugouShortCodeService'

const REAL_SHORT_CODE = 'j2hixca'
const REAL_HASH = 'B9FC03DF9015D6BFF0554A110BF2C84F'

function mixsongPage(shortCode = REAL_SHORT_CODE, hash = REAL_HASH): string {
  return `<script>var dataFromSmarty = ${JSON.stringify([
    {
      hash,
      timelength: 263418,
      audio_name: '周杰伦 - 烟花易冷',
      author_name: '周杰伦',
      song_name: '烟花易冷',
      encode_album_audio_id: shortCode,
    },
  ])},// page track data\nplayType = "search_single";</script>`
}

describe('isKugouShortCode', () => {
  it.each(['j2hixca', '6h5o4sc6', 'abcdef12345678'])('recognizes %s', (value) => {
    expect(isKugouShortCode(value)).toBe(true)
  })

  it.each(['1234567', 'abc', 'abc-123', REAL_HASH])('rejects %s', (value) => {
    expect(isKugouShortCode(value)).toBe(false)
  })
})

describe('resolveKugouShortCode', () => {
  it('parses a validated mixsong page without sending authentication data', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(mixsongPage(), { status: 200, headers: { 'Content-Type': 'text/html' } }))

    await expect(resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl })).resolves.toEqual({
      hash: REAL_HASH,
      songName: '烟花易冷',
      singerName: '周杰伦',
      albumName: undefined,
      duration: 263,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`https://www.kugou.com/mixsong/${REAL_SHORT_CODE}.html`)
    expect(init?.redirect).toBe('manual')
    const headers = new Headers(init?.headers)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
  })

  it('classifies a redirect as an invalid or expired short code', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://www.kugou.com' } }))

    await expect(resolveKugouShortCode('j2hixzz', { fetchImpl })).rejects.toMatchObject({
      code: 'KUGOU_SHORT_CODE_NOT_FOUND',
      httpStatus: 404,
    })
  })

  it.each([
    [new Response(null, { status: 429 }), 'HTTP 429'],
    [new Response('{"err_code":30020,"SSA-CODE":"private-value"}', { status: 200 }), 'err_code 30020'],
  ])('returns a safe security-verification error for %s', async (response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)

    const error = await resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(KugouShortCodeError)
    expect(error).toMatchObject({
      code: 'KUGOU_SECURITY_VERIFICATION_REQUIRED',
      httpStatus: 429,
      message: '酷狗暂时要求安全验证，请稍后重试',
    })
    expect(String(error)).not.toContain('private-value')
  })

  it('classifies a timeout separately', async () => {
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' })
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeout)

    await expect(resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl })).rejects.toMatchObject({
      code: 'KUGOU_UPSTREAM_TIMEOUT',
      httpStatus: 504,
    })
  })

  it.each([500, 502])('classifies HTTP %i as an upstream failure', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))

    await expect(resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl })).rejects.toMatchObject({
      code: 'KUGOU_UPSTREAM_UNAVAILABLE',
      httpStatus: 502,
    })
  })

  it('rejects an oversized response before parsing it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not read', { status: 200, headers: { 'Content-Length': '524289' } }),
    )

    await expect(resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl })).rejects.toMatchObject({
      code: 'KUGOU_UPSTREAM_UNAVAILABLE',
    })
  })

  it('stops reading an oversized response without a Content-Length header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(524_289), { status: 200 }))

    await expect(resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl })).rejects.toMatchObject({
      code: 'KUGOU_UPSTREAM_UNAVAILABLE',
    })
  })

  it('rejects a page whose server-validated short code does not match', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(mixsongPage('j2hixzz'), { status: 200 }))

    await expect(resolveKugouShortCode(REAL_SHORT_CODE, { fetchImpl })).rejects.toMatchObject({
      code: 'KUGOU_UPSTREAM_UNAVAILABLE',
    })
  })

  it.runIf(process.env.KUGOU_LIVE_TEST === '1')('resolves a current real short code through Kugou', async () => {
    await expect(resolveKugouShortCode(REAL_SHORT_CODE)).resolves.toMatchObject({
      hash: REAL_HASH,
      songName: '烟花易冷',
      singerName: '周杰伦',
    })
  })
})
