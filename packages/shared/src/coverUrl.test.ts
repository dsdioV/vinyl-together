import { describe, expect, it } from 'vitest'
import { buildProxiedCoverUrl, sanitizeCoverProxyUrl, sanitizeTrackCoverUrl } from './coverUrl.js'

describe('buildProxiedCoverUrl', () => {
  it('routes a third-party cover through our own origin', () => {
    // Firefox ETP blocks cross-site CDN requests as trackers; same-origin is unaffected.
    const url = buildProxiedCoverUrl('https://y.gtimg.cn/a.jpg', 'https://mt.example')
    expect(url).toBe('https://mt.example/api/music/cover-proxy?url=' + encodeURIComponent('https://y.gtimg.cn/a.jpg'))
    expect(url.startsWith('https://mt.example/')).toBe(true)
  })

  it('tolerates a trailing slash on the server origin', () => {
    expect(buildProxiedCoverUrl('https://p3.music.126.net/b.jpg', 'https://mt.example/')).toBe(
      'https://mt.example/api/music/cover-proxy?url=' + encodeURIComponent('https://p3.music.126.net/b.jpg'),
    )
  })

  it('encodes the upstream URL so its own query string survives', () => {
    const cover = 'https://y.gtimg.cn/a.jpg?x=1&y=2'
    const url = buildProxiedCoverUrl(cover, 'https://mt.example')
    expect(url).toContain(encodeURIComponent(cover))
    // The raw query must not leak into the proxy's own query string.
    expect(url).not.toContain('?x=1&y=2')
  })

  it('produces a URL the cover proxy itself accepts (host allow-listed)', () => {
    for (const cover of [
      'https://y.gtimg.cn/music/photo_new/x.jpg',
      'https://p3.music.126.net/x.jpg',
      'https://imge.kugou.com/x.jpg',
      'https://i0.hdslb.com/x.jpg',
      'https://f4.bcbits.com/x.jpg',
    ]) {
      const proxied = buildProxiedCoverUrl(cover, 'https://mt.example')
      const upstream = decodeURIComponent(new URL(proxied).searchParams.get('url') ?? '')
      // Must survive the proxy's own sanitisation, otherwise every cover would 403.
      expect(sanitizeCoverProxyUrl(upstream)).not.toBe('')
    }
  })

  it('matches the per-source sanitiser used when a Track is registered', () => {
    const raw = 'https://y.gtimg.cn/music/photo_new/x.jpg'
    const accepted = sanitizeTrackCoverUrl(raw, 'tencent')
    expect(accepted).toBe(raw)
    expect(buildProxiedCoverUrl(accepted, 'https://mt.example')).toContain(encodeURIComponent(raw))
  })
})
