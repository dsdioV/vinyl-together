import type { MusicSource, Track } from '@music-together/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveShortCodeMock = vi.hoisted(() => vi.fn())

vi.mock('./kugouShortCodeService.js', async () => {
  const actual = await vi.importActual<typeof import('./kugouShortCodeService.js')>('./kugouShortCodeService.js')
  return { ...actual, resolveKugouShortCode: resolveShortCodeMock }
})

import { KugouShortCodeError } from './kugouShortCodeService.js'
import { MusicProvider } from './musicProvider.js'

type ProviderInternals = {
  fetchNeteaseTrackById(id: string): Promise<Track | null>
  fetchTencentTrackById(id: string): Promise<Track | null>
  fetchKugouTrackById(id: string): Promise<Track | null>
  batchResolveCover(tracks: Track[], source: MusicSource): Promise<void>
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
