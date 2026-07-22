import { describe, expect, it } from 'vitest'
import { parsePlaylistInput } from './musicInput'

describe('parsePlaylistInput', () => {
  it.each([
    ['12345', 'netease'],
    ['001Abc-xyz', 'tencent'],
    ['gcid_3zwlkkpdz1jz0f2', 'kugou'],
  ] as const)('keeps plain ID %s compatible', (input, source) => {
    expect(parsePlaylistInput(input, source)).toBe(input)
  })

  it.each([
    ['https://music.163.com/playlist?id=12345', '12345'],
    ['https://music.163.com/#/playlist?id=23456', '23456'],
    ['https://music.163.com/playlist/34567', '34567'],
  ])('parses a NetEase playlist URL', (input, expected) => {
    expect(parsePlaylistInput(input, 'netease')).toBe(expected)
  })

  it.each([
    ['https://music.163.com/song?id=12345', '12345'],
    ['https://music.163.com/#/song?id=23456', '23456'],
    ['https://music.163.com/album?id=34567', '34567'],
  ])('keeps NetEase song and album URLs compatible', (input, expected) => {
    expect(parsePlaylistInput(input, 'netease')).toBe(expected)
  })

  it('parses a QQ playlist URL', () => {
    expect(parsePlaylistInput('https://y.qq.com/n/ryqq/playlist/12345.html', 'tencent')).toBe('12345')
  })

  it('parses a Kugou short-code track URL', () => {
    expect(parsePlaylistInput('https://www.kugou.com/song/#j2hixca', 'kugou')).toBe('j2hixca')
  })

  it('parses a Kugou hash track URL', () => {
    const hash = 'b9fc03df9015d6bff0554a110bf2c84f'
    expect(parsePlaylistInput(`https://www.kugou.com/song/#hash=${hash}`, 'kugou')).toBe(hash)
  })

  it('parses Kugou songlist and special URLs', () => {
    expect(parsePlaylistInput('https://www.kugou.com/songlist/gcid_3zwlkkpdz1jz0f2/', 'kugou')).toBe(
      'gcid_3zwlkkpdz1jz0f2',
    )
    expect(parsePlaylistInput('https://www.kugou.com/yy/special/single/12345.html', 'kugou')).toBe('12345')
  })

  it.each([
    ['https://example.com/song/#j2hixca', 'kugou'],
    ['https://www.kugou.com.evil.example/song/#j2hixca', 'kugou'],
    ['https://example.com/playlist?id=12345', 'netease'],
    ['https://example.com/n/ryqq/playlist/12345.html', 'tencent'],
  ] as const)('rejects an unofficial hostname', (input, source) => {
    expect(parsePlaylistInput(input, source)).toBeNull()
  })

  it.each([
    'https://[invalid',
    'not a URL containing 12345',
    'https://www.kugou.com/song/',
    'https://www.kugou.com/song/#hash=not-a-hash',
    'https://www.kugou.com/not-song/#j2hixca',
  ])('rejects a malformed or unsupported Kugou URL: %s', (input) => {
    expect(parsePlaylistInput(input, 'kugou')).toBeNull()
  })
})
