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

/**
 * 搜索空结果不得写入 searchIndex。
 *
 * 生产故障：某次 `still alive` 因上游瞬时风控（`Tencent search failed: code 2001`）返回空，
 * 空结果被写进 searchIndex，同一关键词在 10 分钟 TTL 内持续命中空缓存 —— 用户只有换个词
 * 才会触发新搜索。这几条测试锁住「仅当结果非空才写索引」，同时保证非空结果照旧走缓存、
 * registry 淘汰时的 fall-through 未被破坏。
 */

const TENCENT_KEYWORD = 'still alive'

function okResponse(data: unknown) {
  return { ok: true, json: async () => data }
}

/** bilibili 走 fetchBilibiliJson：需要 res.ok + content-type 判 JSON。 */
function bilibiliResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => data,
  }
}

/** Meting 的 _curl 只读 status / headers.entries() / text()。 */
function metingResponse(data: unknown) {
  return {
    status: 200,
    headers: { entries: () => [] as Array<[string, string]> },
    text: async () => JSON.stringify(data),
  }
}

/** 桌面接口风控：code 2001 是生产日志里 `still alive` 返回空的实际原因。 */
function tencentDesktopBlocked() {
  return okResponse({
    code: 0,
    'music.search.SearchCgiService.DoSearchForQQMusicDesktop': { code: 2001 },
  })
}

function tencentDesktopWith(songs: unknown[]) {
  return okResponse({
    code: 0,
    'music.search.SearchCgiService.DoSearchForQQMusicDesktop': {
      code: 0,
      data: { body: { song: { list: songs } } },
    },
  })
}

function tencentSignedWith(songs: unknown[]) {
  return okResponse({ code: 0, req: { code: 0, data: { body: { song: { list: songs } } } } })
}

function tencentLegacyWith(songs: unknown[]) {
  return okResponse({ code: 0, data: { song: { list: songs } } })
}

/** 单曲搜索结果条目（形状与真实 Desktop 响应一致）。 */
function tencentSong(mid: string, mediaMid: string) {
  return {
    id: 1,
    mid,
    name: 'Still Alive',
    title: 'Still Alive',
    interval: 180,
    singer: [{ id: 1, mid: 'singer-1', name: 'BIGBANG' }],
    album: { id: 1, mid: 'album-1', name: '专辑', title: '专辑', pmid: 'album-pmid' },
    file: { media_mid: mediaMid },
    pay: { pay_play: 0, pay_month: 0, pay_down: 0, price_track: 0 },
    action: { icons: 135752, msgpay: 0 },
  }
}

function neteaseSong(id: number) {
  return {
    id,
    name: 'Still Alive',
    ar: [{ name: 'BIGBANG' }],
    al: { name: '专辑' },
    dt: 180000,
    fee: 0,
  }
}

function bilibiliVideo(bvid: string) {
  return {
    bvid,
    aid: 170001,
    cid: 123456,
    title: 'Still Alive',
    author: 'UP主',
    duration: '3:45',
  }
}

interface ProviderInternals {
  searchIndex: LRUCache<string, { source: string; ids: string[] }>
  /** 只需 delete/存在性判定，故用宽松的值类型。 */
  trackRegistry: LRUCache<string, object>
}

function internalsOf(provider: MusicProvider): ProviderInternals {
  return provider as unknown as ProviderInternals
}

describe('MusicProvider search index: empty results are not cached', () => {
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

  function useFetch(impl: (url: string) => unknown) {
    fetchMock = vi.fn(async (url: string) => impl(url))
    vi.stubGlobal('fetch', fetchMock)
  }

  /** 按接口路由的 tencent fetch：`songs` 为空时三条降级链全部返回空。 */
  function routeTencent(current: () => unknown[]) {
    useFetch((url) => {
      if (url.includes('musicu.fcg')) {
        const songs = current()
        return songs.length > 0 ? tencentDesktopWith(songs) : tencentDesktopBlocked()
      }
      if (url.includes('musics.fcg')) return tencentSignedWith(current())
      if (url.includes('client_search_cp')) return tencentLegacyWith(current())
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it('re-queries upstream on the next call after an empty tencent result', async () => {
    let upstream: unknown[] = []
    routeTencent(() => upstream)

    // 第一次：上游瞬时风控 → 空结果，且不得写入索引
    const first = await provider.search('tencent', TENCENT_KEYWORD, 20, 1)
    expect(first).toEqual([])
    expect(internalsOf(provider).searchIndex.get(`tencent:${TENCENT_KEYWORD}:20:1`)).toBeUndefined()

    // 上游恢复：同一关键词必须重新请求上游，而不是命中空缓存
    upstream = [tencentSong('MID1', 'MED1')]
    const callsBeforeSecond = fetchMock.mock.calls.length

    const second = await provider.search('tencent', TENCENT_KEYWORD, 20, 1)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeSecond)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ sourceId: 'MID1', urlId: 'MID1', mediaMid: 'MED1' })
    expect(internalsOf(provider).searchIndex.get(`tencent:${TENCENT_KEYWORD}:20:1`)).toBeDefined()
  })

  it('still serves non-empty tencent results from the index without hitting upstream again', async () => {
    routeTencent(() => [tencentSong('MID1', 'MED1')])

    const first = await provider.search('tencent', TENCENT_KEYWORD, 20, 1)
    expect(first).toHaveLength(1)

    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await provider.search('tencent', TENCENT_KEYWORD, 20, 1)
    expect(second).toHaveLength(1)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
  })

  it('re-fetches when the cached index is stale after registry eviction', async () => {
    routeTencent(() => [tencentSong('MID1', 'MED1')])

    await provider.search('tencent', TENCENT_KEYWORD, 20, 1)
    const callsAfterFirst = fetchMock.mock.calls.length

    // 模拟 registry（LRU）淘汰：索引还在但 Track 元数据已丢失
    internalsOf(provider).trackRegistry.delete('tencent:MID1')

    const second = await provider.search('tencent', TENCENT_KEYWORD, 20, 1)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    expect(second).toHaveLength(1)
  })

  it('does not cache an empty bilibili search result', async () => {
    let videos: unknown[] = []
    useFetch((url) => {
      if (url.includes('/x/frontend/finger/spi')) return bilibiliResponse({ data: { b_3: 'B3', b_4: 'B4' } })
      if (url.includes('search/type')) return bilibiliResponse({ code: 0, data: { result: videos } })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const first = await provider.search('bilibili', TENCENT_KEYWORD, 20, 1)
    expect(first).toEqual([])
    expect(internalsOf(provider).searchIndex.get(`bilibili:${TENCENT_KEYWORD}:20:1`)).toBeUndefined()

    videos = [bilibiliVideo('BV1xx411c7mD')]
    const second = await provider.search('bilibili', TENCENT_KEYWORD, 20, 1)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ sourceId: 'BV1xx411c7mD' })
  })

  /**
   * meting 兜底路径（netease/kugou 等）的空结果其实由 1504 行的
   * `if (!Array.isArray(songs) || songs.length === 0) return []` 提前拦下，
   * `songs.map()` 保持长度，所以这里的 `tracks.length > 0` 是不可达的兜底（规范化用，
   * 与 bandcamp 范式统一）。本用例锁定的是端到端不变量：空 → 不缓存 → 下次仍重新请求；
   * 去掉该处 guard 这个用例依然通过，属预期。
   */
  it('does not cache an empty meting (netease) search result', async () => {
    let songs: unknown[] = []
    useFetch((url) => {
      if (url.includes('cloudsearch')) return metingResponse({ result: { songs } })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const first = await provider.search('netease', TENCENT_KEYWORD, 20, 1)
    expect(first).toEqual([])
    expect(internalsOf(provider).searchIndex.get(`netease:${TENCENT_KEYWORD}:20:1`)).toBeUndefined()

    songs = [neteaseSong(1)]
    const second = await provider.search('netease', TENCENT_KEYWORD, 20, 1)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ sourceId: '1' })
    expect(internalsOf(provider).searchIndex.get(`netease:${TENCENT_KEYWORD}:20:1`)).toBeDefined()
  })
})
