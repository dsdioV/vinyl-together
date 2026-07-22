import { LIMITS, type MusicSource, type Track } from '@music-together/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveShortCodeMock = vi.hoisted(() => vi.fn())
const ncmApiMock = vi.hoisted(() => ({
  album: vi.fn(),
  playlist_track_all: vi.fn(),
  song_detail: vi.fn(),
}))
const kugouPlaylistTracksMock = vi.hoisted(() => vi.fn())
const tencentPlaylistTracksMock = vi.hoisted(() => vi.fn())

vi.mock('./kugouShortCodeService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouShortCodeService.js')>('./kugouShortCodeService.js')
  return { ...actual, resolveKugouShortCode: resolveShortCodeMock }
})

vi.mock('@neteasecloudmusicapienhanced/api', () => ({ default: ncmApiMock }))

vi.mock('./kugouAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouAuthService.js')>('./kugouAuthService.js')
  return { ...actual, getPlaylistTracks: kugouPlaylistTracksMock }
})

vi.mock('./tencentAuthService.js', async () => {
  const actual = await vi.importActual<typeof import('./tencentAuthService.js')>('./tencentAuthService.js')
  return { ...actual, getPlaylistTracks: tencentPlaylistTracksMock }
})

import { KugouShortCodeError } from './kugouShortCodeService.js'
import { MusicProvider, PlaylistSearchLimitError } from './musicProvider.js'

type ProviderInternals = {
  fetchNeteaseTrackById(id: string): Promise<Track | null>
  fetchTencentTrackById(id: string): Promise<Track | null>
  fetchKugouTrackById(id: string): Promise<Track | null>
  batchResolveCover(tracks: Track[], source: MusicSource): Promise<void>
  registerTracks(tracks: Track[]): void
  playlistIndex: { keys(): IterableIterator<string> }
}

function track(source: MusicSource, sourceId: string): Track {
  return {
    id: `id-${sourceId}`,
    title: 'Title',
    artist: ['Artist'],
    album: 'Album',
    duration: 120,
    cover: 'https://example.test/cover.jpg',
    source,
    sourceId,
    urlId: sourceId,
  }
}

function neteaseSong(id: number): Record<string, unknown> {
  return {
    id,
    name: `Song ${id}`,
    ar: [{ name: 'Artist' }],
    al: { name: 'Album', pic: id },
    dt: 120_000,
    fee: 0,
  }
}

function tencentSong(id: number): Record<string, unknown> {
  return {
    mid: `qq-${id}`,
    name: `Song ${id}`,
    singer: [{ name: 'Artist' }],
    album: { title: 'Album', mid: `album-${id}` },
    interval: 120,
  }
}

function kugouSong(id: number): Record<string, unknown> {
  return {
    hash: `kg-${id}`,
    filename: `Artist - Song ${id}`,
    album_name: 'Album',
    duration: 120,
  }
}

describe('MusicProvider.getTrackById dispatch', () => {
  beforeEach(() => {
    resolveShortCodeMock.mockReset()
  })

  it.each([
    ['netease', '12345', 'fetchNeteaseTrackById'],
    ['tencent', '0039MnYb0qxYhV', 'fetchTencentTrackById'],
  ] as const)('keeps %s IDs on their existing provider path', async (source, sourceId, method) => {
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    const expected = track(source, sourceId)
    const fetchSpy = vi.spyOn(internals, method).mockResolvedValue(expected)

    await expect(provider.getTrackById(source, sourceId)).resolves.toMatchObject(expected)
    expect(fetchSpy).toHaveBeenCalledWith(sourceId)
    expect(resolveShortCodeMock).not.toHaveBeenCalled()
  })

  it('keeps a 32-character Kugou hash on the hash path', async () => {
    const hash = 'B9FC03DF9015D6BFF0554A110BF2C84F'
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    const fetchSpy = vi.spyOn(internals, 'fetchKugouTrackById').mockResolvedValue(track('kugou', hash))

    await expect(provider.getTrackById('kugou', hash)).resolves.toMatchObject({ sourceId: hash })
    expect(fetchSpy).toHaveBeenCalledWith(hash)
    expect(resolveShortCodeMock).not.toHaveBeenCalled()
  })

  it('resolves a short code once and replaces Unknown metadata', async () => {
    const hash = 'B9FC03DF9015D6BFF0554A110BF2C84F'
    resolveShortCodeMock.mockResolvedValue({
      hash,
      songName: '烟花易冷',
      singerName: '周杰伦',
      duration: 263,
    })
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    vi.spyOn(internals, 'fetchKugouTrackById').mockResolvedValue({
      ...track('kugou', hash),
      title: 'Unknown',
      artist: ['Unknown'],
      album: '',
      duration: 0,
    })

    await expect(provider.getTrackById('kugou', 'j2hixca')).resolves.toMatchObject({
      sourceId: hash,
      title: '烟花易冷',
      artist: ['周杰伦'],
      duration: 263,
    })
    expect(resolveShortCodeMock).toHaveBeenCalledOnce()
  })

  it('builds a usable track when the legacy hash detail API is unavailable', async () => {
    const hash = 'B9FC03DF9015D6BFF0554A110BF2C84F'
    resolveShortCodeMock.mockResolvedValue({
      hash,
      songName: '烟花易冷',
      singerName: '周杰伦',
      duration: 263,
    })
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    vi.spyOn(internals, 'fetchKugouTrackById').mockResolvedValue(null)
    vi.spyOn(internals, 'batchResolveCover').mockResolvedValue()

    await expect(provider.getTrackById('kugou', 'j2hixca')).resolves.toMatchObject({
      source: 'kugou',
      sourceId: hash,
      urlId: hash,
      title: '烟花易冷',
      artist: ['周杰伦'],
      duration: 263,
    })
  })

  it('does not retry a failed short code as a hash', async () => {
    resolveShortCodeMock.mockRejectedValue(
      new KugouShortCodeError('KUGOU_SHORT_CODE_NOT_FOUND', '酷狗短码无效或已过期', 404),
    )
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    const fetchSpy = vi.spyOn(internals, 'fetchKugouTrackById')

    await expect(provider.getTrackById('kugou', 'j2hixzz')).rejects.toMatchObject({
      code: 'KUGOU_SHORT_CODE_NOT_FOUND',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('MusicProvider.searchPlaylistTracks', () => {
  beforeEach(() => {
    ncmApiMock.album.mockReset()
    ncmApiMock.playlist_track_all.mockReset()
    kugouPlaylistTracksMock.mockReset()
    tencentPlaylistTracksMock.mockReset()
  })

  it('finds title and artist matches beyond the first 1000 tracks and resolves covers per result page', async () => {
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    const tracks = Array.from({ length: 1061 }, (_, index) => ({
      ...track('netease', String(index)),
      title: index >= 1001 && index % 2 === 0 ? `Deep NEEDLE ${index}` : `Song ${index}`,
      artist: index >= 1001 && index % 2 === 1 ? ['NeedLe Singer'] : ['Artist'],
      cover: '',
      picId: `pic-${index}`,
    }))
    const ids = tracks.map((item) => item.sourceId)
    internals.registerTracks(tracks)

    const fetchSpy = vi.spyOn(provider, 'fetchFullPlaylist').mockResolvedValue({ ids, total: tracks.length })
    const coverSpy = vi.spyOn(internals, 'batchResolveCover').mockResolvedValue()

    const firstPage = await provider.searchPlaylistTracks(
      'netease',
      'playlist-id',
      'nEeDlE',
      1,
      100,
      tracks.length,
      'MUSIC_U=test-cookie',
      'album',
    )

    expect(fetchSpy).toHaveBeenCalledWith(
      'netease',
      'playlist-id',
      undefined,
      'MUSIC_U=test-cookie',
      'album',
      LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
    )
    expect(firstPage.tracks).toHaveLength(50)
    expect(firstPage.tracks[0]?.sourceId).toBe('1001')
    expect(firstPage.tracks[49]?.sourceId).toBe('1050')
    expect(firstPage.total).toBe(60)
    expect(firstPage.hasMore).toBe(true)
    expect(coverSpy).toHaveBeenLastCalledWith(firstPage.tracks, 'netease')
    expect(coverSpy.mock.calls[0]?.[0]).toHaveLength(50)

    const secondPage = await provider.searchPlaylistTracks('netease', 'playlist-id', 'needle', 2, 50)

    expect(secondPage.tracks).toHaveLength(10)
    expect(secondPage.tracks[0]?.sourceId).toBe('1051')
    expect(secondPage.tracks[9]?.sourceId).toBe('1060')
    expect(secondPage.total).toBe(60)
    expect(secondPage.hasMore).toBe(false)
    expect(coverSpy.mock.calls[1]?.[0]).toHaveLength(10)
  })

  it('fetches and searches a 1061-track playlist whose only hit is after track 1000', async () => {
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    const firstChunk = Array.from({ length: 1000 }, (_, index) => neteaseSong(index))
    const finalChunk = Array.from({ length: 61 }, (_, index) => {
      const id = 1000 + index
      return {
        ...neteaseSong(id),
        name: id === 1005 ? 'Acceptance Needle' : `Song ${id}`,
      }
    })
    ncmApiMock.playlist_track_all
      .mockResolvedValueOnce({ body: { songs: firstChunk } })
      .mockResolvedValueOnce({ body: { songs: finalChunk } })
    vi.spyOn(internals, 'batchResolveCover').mockResolvedValue()

    const result = await provider.searchPlaylistTracks(
      'netease',
      'acceptance-playlist',
      'needle',
      1,
      50,
      1000,
    )

    expect(ncmApiMock.playlist_track_all).toHaveBeenCalledTimes(2)
    expect(ncmApiMock.playlist_track_all).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'acceptance-playlist', offset: 1000 }),
    )
    expect(result).toMatchObject({ total: 1, hasMore: false })
    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0]).toMatchObject({ sourceId: '1005', title: 'Acceptance Needle' })
  })

  it('supports the final page for an 8192-track result set', async () => {
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    const tracks = Array.from({ length: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS }, (_, index) => ({
      ...track('tencent', String(index)),
      title: `Match ${index}`,
      cover: '',
    }))
    const ids = tracks.map((item) => item.sourceId)
    internals.registerTracks(tracks)
    vi.spyOn(provider, 'fetchFullPlaylist').mockResolvedValue({ ids, total: tracks.length })
    vi.spyOn(internals, 'batchResolveCover').mockResolvedValue()

    const result = await provider.searchPlaylistTracks(
      'tencent',
      'playlist-id',
      'match',
      LIMITS.PLAYLIST_SEARCH_PAGE_MAX,
      LIMITS.PLAYLIST_SEARCH_PAGE_SIZE,
    )

    const lastPageOffset =
      (LIMITS.PLAYLIST_SEARCH_PAGE_MAX - 1) * LIMITS.PLAYLIST_SEARCH_PAGE_SIZE
    expect(result.tracks).toHaveLength(LIMITS.PLAYLIST_SEARCH_MAX_TRACKS - lastPageOffset)
    expect(result.tracks[0]?.sourceId).toBe(String(lastPageOffset))
    expect(result.tracks.at(-1)?.sourceId).toBe(String(LIMITS.PLAYLIST_SEARCH_MAX_TRACKS - 1))
    expect(result.total).toBe(LIMITS.PLAYLIST_SEARCH_MAX_TRACKS)
    expect(result.hasMore).toBe(false)
  })

  it('fetches Netease playlists to the API end instead of trusting a smaller client total', async () => {
    const provider = new MusicProvider()
    const firstChunk = Array.from({ length: 1000 }, (_, index) => ({
      id: index,
      name: `Song ${index}`,
      ar: [{ name: 'Artist' }],
      al: { name: 'Album', pic: index },
      dt: 120_000,
      fee: 0,
    }))
    const finalChunk = [
      {
        id: 1000,
        name: 'Beyond the hint',
        ar: [{ name: 'Artist' }],
        al: { name: 'Album', pic: 1000 },
        dt: 120_000,
        fee: 0,
      },
    ]
    ncmApiMock.playlist_track_all
      .mockResolvedValueOnce({ body: { songs: firstChunk } })
      .mockResolvedValueOnce({ body: { songs: finalChunk } })

    const result = await provider.fetchFullPlaylist('netease', 'playlist-id', 1000, 'MUSIC_U=test-cookie')

    expect(result.total).toBe(1001)
    expect(result.ids[1000]).toBe('1000')
    expect(ncmApiMock.playlist_track_all).toHaveBeenCalledTimes(2)
    expect(ncmApiMock.playlist_track_all).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'playlist-id', limit: 1000, offset: 0, cookie: 'MUSIC_U=test-cookie' }),
    )
    expect(ncmApiMock.playlist_track_all).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'playlist-id', limit: 1000, offset: 1000, cookie: 'MUSIC_U=test-cookie' }),
    )
  })

  it('keeps album and playlist indexes separate when their external IDs match', async () => {
    const provider = new MusicProvider()
    ncmApiMock.album.mockResolvedValue({
      body: {
        songs: [
          {
            id: 1,
            name: 'Album track',
            ar: [{ name: 'Artist' }],
            al: { name: 'Album', pic: 1 },
            dt: 120_000,
            fee: 0,
          },
        ],
      },
    })
    ncmApiMock.playlist_track_all.mockResolvedValue({
      body: {
        songs: [
          {
            id: 2,
            name: 'Playlist track',
            ar: [{ name: 'Artist' }],
            al: { name: 'Album', pic: 2 },
            dt: 120_000,
            fee: 0,
          },
        ],
      },
    })

    const album = await provider.fetchFullPlaylist('netease', 'same-id', undefined, null, 'album')
    const playlist = await provider.fetchFullPlaylist('netease', 'same-id', undefined, null, 'playlist')

    expect(album.ids).toEqual(['1'])
    expect(playlist.ids).toEqual(['2'])
    expect(ncmApiMock.album).toHaveBeenCalledOnce()
    expect(ncmApiMock.playlist_track_all).toHaveBeenCalledOnce()
  })

  it('isolates playlist indexes by hashed authentication credentials', async () => {
    const provider = new MusicProvider()
    const internals = provider as unknown as ProviderInternals
    ncmApiMock.playlist_track_all.mockImplementation(({ cookie }: { cookie?: string }) => {
      const id = cookie === 'MUSIC_U=alpha-secret' ? 1 : cookie === 'MUSIC_U=beta-secret' ? 2 : 3
      return { body: { songs: [neteaseSong(id)] } }
    })

    const anonymous = await provider.fetchFullPlaylist('netease', 'private-playlist')
    const alpha = await provider.fetchFullPlaylist(
      'netease',
      'private-playlist',
      undefined,
      'MUSIC_U=alpha-secret',
    )
    const beta = await provider.fetchFullPlaylist(
      'netease',
      'private-playlist',
      undefined,
      'MUSIC_U=beta-secret',
    )
    const alphaCached = await provider.fetchFullPlaylist(
      'netease',
      'private-playlist',
      undefined,
      'MUSIC_U=alpha-secret',
    )

    expect(anonymous.ids).toEqual(['3'])
    expect(alpha.ids).toEqual(['1'])
    expect(beta.ids).toEqual(['2'])
    expect(alphaCached.ids).toEqual(['1'])
    expect(ncmApiMock.playlist_track_all).toHaveBeenCalledTimes(3)

    const cacheKeys = Array.from(internals.playlistIndex.keys())
    expect(cacheKeys).toHaveLength(3)
    expect(cacheKeys.join('\n')).not.toContain('alpha-secret')
    expect(cacheKeys.join('\n')).not.toContain('beta-secret')
    expect(cacheKeys.filter((key) => key.endsWith(':auth:anonymous'))).toHaveLength(1)
    expect(cacheKeys.filter((key) => /:auth:[a-f0-9]{64}$/.test(key))).toHaveLength(2)
  })

  it('continues Tencent pagination when total is under-reported', async () => {
    const provider = new MusicProvider()
    tencentPlaylistTracksMock
      .mockResolvedValueOnce({
        songs: Array.from({ length: 100 }, (_, index) => tencentSong(index)),
        total: 1,
      })
      .mockResolvedValueOnce({ songs: [tencentSong(100)], total: 0 })

    const result = await provider.fetchFullPlaylist('tencent', 'playlist-id')

    expect(result.total).toBe(101)
    expect(result.ids.at(-1)).toBe('qq-100')
    expect(tencentPlaylistTracksMock).toHaveBeenCalledTimes(2)
  })

  it('continues Kugou pagination when total is missing', async () => {
    const provider = new MusicProvider()
    kugouPlaylistTracksMock
      .mockResolvedValueOnce({
        songs: Array.from({ length: 300 }, (_, index) => kugouSong(index)),
        total: 0,
      })
      .mockResolvedValueOnce({ songs: [kugouSong(300)], total: 0 })

    const result = await provider.fetchFullPlaylist('kugou', 'playlist-id')

    expect(result.total).toBe(301)
    expect(result.ids.at(-1)).toBe('kg-300')
    expect(kugouPlaylistTracksMock).toHaveBeenCalledTimes(2)
  })

  it('stops ordinary Kugou browsing when the upstream repeats a full page', async () => {
    const provider = new MusicProvider()
    const repeatedPage = Array.from({ length: 300 }, (_, index) => kugouSong(index))
    kugouPlaylistTracksMock.mockResolvedValue({ songs: repeatedPage, total: 0 })

    const result = await provider.fetchFullPlaylist('kugou', 'repeating-playlist')

    expect(result.total).toBe(300)
    expect(kugouPlaylistTracksMock).toHaveBeenCalledTimes(2)
  })

  it('fails full Tencent search instead of accepting a repeated page as complete', async () => {
    const provider = new MusicProvider()
    const repeatedPage = Array.from({ length: 100 }, (_, index) => tencentSong(index))
    tencentPlaylistTracksMock.mockResolvedValue({ songs: repeatedPage, total: 0 })

    await expect(provider.searchPlaylistTracks('tencent', 'repeating-playlist', 'song')).rejects.toMatchObject({
      name: 'PlaylistPaginationError',
    })
    expect(tencentPlaylistTracksMock).toHaveBeenCalledTimes(2)
  })

  it('caps abnormal ordinary Tencent pagination at 100000 tracks', async () => {
    const provider = new MusicProvider()
    tencentPlaylistTracksMock.mockImplementation(
      (_playlistId: string, page: number, pageSize: number) => ({
        songs: Array.from({ length: pageSize }, (_, index) => tencentSong((page - 1) * pageSize + index)),
        total: 0,
      }),
    )

    const result = await provider.fetchFullPlaylist('tencent', 'unbounded-playlist')

    expect(result.total).toBe(100_000)
    expect(result.ids.at(-1)).toBe('qq-99999')
    expect(tencentPlaylistTracksMock).toHaveBeenCalledTimes(1_000)
  })

  it('applies the 8192-track limit to ordinary playlist browsing', async () => {
    const provider = new MusicProvider()
    const actualTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1
    const fetchSpy = vi
      .spyOn(provider, 'fetchFullPlaylist')
      .mockRejectedValue(new PlaylistSearchLimitError(actualTracks))

    await expect(provider.getPlaylistPage('kugou', 'large-playlist', 1000, 0)).rejects.toMatchObject({
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      actualTracks,
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'kugou',
      'large-playlist',
      undefined,
      undefined,
      'playlist',
      LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
    )
  })

  it('rejects Tencent search as soon as the 8193rd track is discovered', async () => {
    const provider = new MusicProvider()
    tencentPlaylistTracksMock.mockImplementation(
      (_playlistId: string, page: number, pageSize: number) => ({
        songs: Array.from({ length: pageSize }, (_, index) => tencentSong((page - 1) * pageSize + index)),
        total: 0,
      }),
    )

    await expect(provider.searchPlaylistTracks('tencent', 'oversized', 'song')).rejects.toMatchObject({
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      actualTracks: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1,
    })
    expect(tencentPlaylistTracksMock).toHaveBeenCalledTimes(
      Math.floor(LIMITS.PLAYLIST_SEARCH_MAX_TRACKS / 100) + 1,
    )
  })

  it('rejects Kugou search as soon as the 8193rd track is discovered', async () => {
    const provider = new MusicProvider()
    kugouPlaylistTracksMock.mockImplementation(
      (_playlistId: string, page: number, pageSize: number) => ({
        songs: Array.from({ length: pageSize }, (_, index) => kugouSong((page - 1) * pageSize + index)),
        total: 0,
      }),
    )

    await expect(provider.searchPlaylistTracks('kugou', 'oversized', 'song')).rejects.toMatchObject({
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      actualTracks: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1,
    })
    expect(kugouPlaylistTracksMock).toHaveBeenCalledTimes(
      Math.floor(LIMITS.PLAYLIST_SEARCH_MAX_TRACKS / 300) + 1,
    )
  })

  it('rejects a known oversized playlist before fetching it', async () => {
    const provider = new MusicProvider()
    const fetchSpy = vi.spyOn(provider, 'fetchFullPlaylist')

    const actualTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1
    await expect(
      provider.searchPlaylistTracks('kugou', 'playlist-id', 'song', 1, 50, actualTracks),
    ).rejects.toMatchObject({
      name: 'PlaylistSearchLimitError',
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      maxTracks: LIMITS.PLAYLIST_SEARCH_MAX_TRACKS,
      actualTracks,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects an oversized playlist discovered while fetching', async () => {
    const provider = new MusicProvider()
    const actualTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1
    const ids = Array.from({ length: actualTracks }, (_, index) => String(index))
    vi.spyOn(provider, 'fetchFullPlaylist').mockResolvedValue({ ids, total: ids.length })

    await expect(provider.searchPlaylistTracks('netease', 'playlist-id', 'song')).rejects.toEqual(
      new PlaylistSearchLimitError(actualTracks),
    )
  })

  it('stops an unbounded Netease fetch after proving the playlist exceeds 8192 tracks', async () => {
    const provider = new MusicProvider()
    const actualTracks = LIMITS.PLAYLIST_SEARCH_MAX_TRACKS + 1
    const lastOffset = Math.floor(LIMITS.PLAYLIST_SEARCH_MAX_TRACKS / 1000) * 1000
    ncmApiMock.playlist_track_all.mockImplementation(({ limit, offset }: { limit: number; offset: number }) => ({
      body: {
        songs: Array.from({ length: limit }, (_, index) => ({
          id: offset + index,
          name: `Song ${offset + index}`,
          ar: [{ name: 'Artist' }],
          al: { name: 'Album', pic: offset + index },
          dt: 120_000,
          fee: 0,
        })),
      },
    }))

    await expect(provider.searchPlaylistTracks('netease', 'oversized', 'song')).rejects.toMatchObject({
      code: 'PLAYLIST_TRACK_LIMIT_EXCEEDED',
      actualTracks,
    })
    expect(ncmApiMock.playlist_track_all).toHaveBeenCalledTimes(Math.ceil(actualTracks / 1000))
    expect(ncmApiMock.playlist_track_all).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: actualTracks - lastOffset, offset: lastOffset }),
    )
  })
})
