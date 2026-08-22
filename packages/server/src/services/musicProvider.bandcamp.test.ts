import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LRUCache } from 'lru-cache'

vi.mock('@neteasecloudmusicapienhanced/api', () => ({ default: {} }))

vi.mock('./neteaseApiBootstrap.js', () => ({
  ensureNeteaseApiReady: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./kugouShortCodeService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouShortCodeService.js')>('./kugouShortCodeService.js')
  return { ...actual, resolveKugouShortCode: vi.fn() }
})

vi.mock('./kugouAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouAuthService.js')>('./kugouAuthService.js')
  return { ...actual, getPlayUrl: vi.fn(), getCover: vi.fn() }
})

vi.mock('./tencentAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./tencentAuthService.js')>('./tencentAuthService.js')
  return actual
})

import { MusicProvider } from './musicProvider.js'

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) }
}

function htmlResponse(html: string) {
  return { ok: true, status: 200, text: async () => html }
}

/** data-tralbum 属性值经 HTML 转义（引号 → &quot;），与真实页面一致。 */
function tralbumPage(tralbum: unknown): string {
  const json = JSON.stringify(tralbum).replace(/"/g, '&quot;')
  return `<html><head><title>Album</title></head><body><div data-tralbum="${json}"></div></body></html>`
}

const CHALLENGE_HTML =
  '<html lang="en"><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'" /><link href="/_fs-ch-1T1wmsGaOgGaSxcX/assets/styles.css" rel="stylesheet" /><title>Client Challenge</title></head><body></body></html>'

const TRACK_PAGE_URL = 'https://hitoridayo.bandcamp.com/track/yorushika-hitori-bootleg'
const ALBUM_PAGE_URL = 'https://174udsi.bandcamp.com/album/frieren-op-2-haru-remix'

describe('MusicProvider bandcamp source', () => {
  let provider: MusicProvider
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    provider = new MusicProvider()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('searches tracks through autocomplete_elastic and filters to type=t', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        auto: {
          results: [
            {
              type: 'a',
              id: 2642768301,
              name: 'Some Album',
              item_url_path: 'https://174udsi.bandcamp.com/album/some-album',
              img: 'https://f4.bcbits.com/img/3580032294_3.jpg',
            },
            {
              type: 't',
              id: 4006227418,
              name: 'Yorushika - 晴る (HITORI. Bootleg)',
              band_name: 'HITORI.',
              album_name: null,
              item_url_path: TRACK_PAGE_URL,
              art_id: 271744234,
            },
            {
              type: 't',
              name: '没有链接的脏数据',
              id: 4006227419,
            },
          ],
        },
      }),
    )

    const tracks = await provider.search('bandcamp', 'yorushika', 20, 1)

    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({
      source: 'bandcamp',
      sourceId: '4006227418',
      urlId: TRACK_PAGE_URL,
      title: 'Yorushika - 晴る (HITORI. Bootleg)',
      artist: ['HITORI.'],
      album: '',
      duration: 0,
      cover: 'https://f4.bcbits.com/img/a271744234_10.jpg',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('bcsearch_public_api/1/autocomplete_elastic')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ search_text: 'yorushika', search_filter: 't', full_page: false })
    expect((init.headers as Record<string, string>)['User-Agent']).not.toContain('Mozilla')
  })

  it('does not cache empty search results (transient failures must not poison the keyword)', async () => {
    // 上游返回空（如瞬时故障）时不应写入 searchIndex
    fetchMock.mockResolvedValueOnce(jsonResponse({ auto: { results: [] } }))
    const tracks = await provider.search('bandcamp', 'strawberry', 20, 1)
    expect(tracks).toEqual([])

    const internals = provider as unknown as { searchIndex: LRUCache<string, unknown> }
    expect(internals.searchIndex.get('bandcamp:strawberry:20:1')).toBeUndefined()

    // 有结果时正常写索引
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        auto: {
          results: [
            {
              type: 't',
              id: 4006227418,
              name: 'Bootleg',
              band_name: 'HITORI.',
              item_url_path: TRACK_PAGE_URL,
              art_id: 271744234,
            },
          ],
        },
      }),
    )
    await provider.search('bandcamp', 'strawberry', 20, 1)
    expect(internals.searchIndex.get('bandcamp:strawberry:20:1')).toBeDefined()
  })

  it('searches albums and maps them to playlists keyed by page URL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        auto: {
          results: [
            {
              type: 'a',
              id: 2642768301,
              name: 'Frieren OP 2 Remix',
              band_name: '174UDSI',
              item_url_path: ALBUM_PAGE_URL,
              art_id: 3580032294,
            },
            {
              type: 't',
              id: 1,
              name: 'ignored track',
              item_url_path: TRACK_PAGE_URL,
            },
          ],
        },
      }),
    )

    const albums = await provider.searchAlbum('bandcamp', 'yorushika', 20, 1)

    expect(albums).toHaveLength(1)
    expect(albums[0]).toMatchObject({
      id: ALBUM_PAGE_URL,
      name: 'Frieren OP 2 Remix',
      cover: 'https://f4.bcbits.com/img/a3580032294_10.jpg',
      creator: '174UDSI',
      source: 'bandcamp',
    })
  })

  it('resolves the mp3-128 stream from a track page and skips the stream cache', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        tralbumPage({
          item_type: 'track',
          artist: 'HITORI.',
          title: 'Yorushika - 晴る (HITORI. Bootleg)',
          art_id: 271744234,
          trackinfo: [
            {
              id: 4006227418,
              title: 'Yorushika - 晴る (HITORI. Bootleg)',
              duration: 225.1,
              file: { 'mp3-128': '//t4.bcbits.com/stream/deadbeef/mp3-128/4006227418?p=0&ts=1787408852&t=f00d' },
            },
          ],
        }),
      ),
    )

    const result = await provider.getStreamUrlResult('bandcamp', TRACK_PAGE_URL, 320)

    expect(result.url).toBe(
      'https://t4.bcbits.com/stream/deadbeef/mp3-128/4006227418?p=0&ts=1787408852&t=f00d',
    )
    expect(result.reason).toBeUndefined()

    // token 时效短：不允许写入 streamUrlCache
    const internals = provider as unknown as { streamUrlCache: LRUCache<string, string> }
    expect(internals.streamUrlCache.get(`bandcamp:${TRACK_PAGE_URL}:320`)).toBeUndefined()

    const [pageUrl, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(pageUrl).toBe(TRACK_PAGE_URL)
    expect(init.headers['User-Agent']).not.toContain('Mozilla')
  })

  it('resolves a specific track from an album page using the #trackId urlId form', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        tralbumPage({
          item_type: 'album',
          artist: '174UDSI, Yorushika(ヨルシカ)',
          title: 'Frieren OP 2 Remix',
          art_id: 3580032294,
          trackinfo: [
            {
              id: 1929149707,
              title: 'Main',
              duration: 102.867,
              file: { 'mp3-128': '//t4.bcbits.com/stream/aaaa/mp3-128/1929149707?t=1' },
            },
            {
              id: 2884461888,
              title: 'Inst',
              duration: 102.867,
              file: { 'mp3-128': '//t4.bcbits.com/stream/bbbb/mp3-128/2884461888?t=2' },
            },
          ],
        }),
      ),
    )

    const result = await provider.getStreamUrlResult('bandcamp', `${ALBUM_PAGE_URL}#2884461888`, 999)

    expect(result.url).toBe('https://t4.bcbits.com/stream/bbbb/mp3-128/2884461888?t=2')
  })

  it('classifies the anti-bot challenge page as upstream_failed', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(CHALLENGE_HTML))

    const result = await provider.getStreamUrlResult('bandcamp', TRACK_PAGE_URL, 320)

    expect(result.url).toBeNull()
    expect(result.reason).toBe('upstream_failed')
    expect(result.detail).toBe('Bandcamp 反爬拦截')
  })

  it('expands an album page into registered tracks with real durations', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        tralbumPage({
          item_type: 'album',
          artist: '174UDSI, Yorushika(ヨルシカ)',
          title: 'Frieren OP 2 Remix',
          art_id: 3580032294,
          trackinfo: [
            {
              id: 1929149707,
              title: 'Main',
              duration: 102.867,
              title_link: '/track/frieren-haru-remix',
              file: { 'mp3-128': '//t4.bcbits.com/stream/aaaa/mp3-128/1929149707?t=1' },
            },
            {
              id: 2884461888,
              title: 'Inst',
              duration: 100,
              file: null,
            },
          ],
        }),
      ),
    )

    const page = await provider.getPlaylistPage('bandcamp', ALBUM_PAGE_URL, 10, 0, undefined, undefined, 'album')

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(false)
    expect(page.tracks).toHaveLength(2)
    expect(page.tracks[0]).toMatchObject({
      source: 'bandcamp',
      sourceId: '1929149707',
      urlId: 'https://174udsi.bandcamp.com/track/frieren-haru-remix',
      title: 'Main',
      artist: ['174UDSI, Yorushika(ヨルシカ)'],
      album: 'Frieren OP 2 Remix',
      duration: 103,
      cover: 'https://f4.bcbits.com/img/a3580032294_10.jpg',
    })
    // 无 title_link 的曲目回退「专辑页#trackId」形态，流解析时可按 id 定位
    expect(page.tracks[1]?.urlId).toBe(`${ALBUM_PAGE_URL}#2884461888`)
  })

  it('resolves pasted track URLs via getTrackById and returns null for unknown numeric IDs', async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        tralbumPage({
          item_type: 'track',
          artist: 'HITORI.',
          title: 'Bootleg',
          trackinfo: [{ id: 4006227418, title: 'Bootleg', duration: 225, file: {} }],
        }),
      ),
    )

    const track = await provider.getTrackById('bandcamp', TRACK_PAGE_URL)
    // fixture 未提供 title_link，urlId 按设计回退「页面#trackId」形态
    expect(track).toMatchObject({
      source: 'bandcamp',
      sourceId: '4006227418',
      urlId: `${TRACK_PAGE_URL}#4006227418`,
    })

    // 纯数字 ID 无法定位页面（注册表未命中即返回 null），不应发起请求
    fetchMock.mockClear()
    await expect(provider.getTrackById('bandcamp', '999999')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps lyric and cover lookups empty for bandcamp', async () => {
    await expect(provider.getLyric('bandcamp', '4006227418')).resolves.toEqual({
      lyric: '',
      tlyric: '',
      romalrc: '',
      yrc: '',
    })
    await expect(provider.getCover('bandcamp', '4006227418')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns no playlists and no full-playlist index for bandcamp', async () => {
    await expect(provider.searchPlaylist('bandcamp', 'keyword', 20, 1)).resolves.toEqual([])
    await expect(provider.fetchFullPlaylist('bandcamp', 'whatever', undefined, undefined, 'playlist')).resolves.toEqual(
      { ids: [], total: 0 },
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
