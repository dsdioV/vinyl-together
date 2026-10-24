// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// 端到端回归：账号页在房间持续重渲染时仍然会轮询扫码状态
//
// 生产事故现场（2026-10-02）：用户在繁忙房间里扫码并在手机确认后，
// 网站毫无反应；新建一个空房间再扫码就能登录。根因是 PlatformHub 用内联
// 箭头函数把 onCheckStatus 传给 QrLoginDialog，而该回调位于 2s 轮询
// effect 的依赖数组中 —— 房间每有事件（播放、成员进出、歌单无限重拉）
// PlatformHub 就重渲染一次，定时器被清掉重建，服务端一次 AUTH_CHECK_QR
// 都收不到。空房间没有事件，定时器得以存活，所以「新开房间就能登录」。
// ---------------------------------------------------------------------------

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connected: true,
  id: 'socket-1',
}

vi.mock('@/providers/SocketProvider', () => ({
  useSocketContext: () => ({ socket: mockSocket, isConnected: true, connectionState: 'connected' }),
}))

interface AuthState {
  platformStatus: unknown[]
  myStatus: unknown[]
  statusLoaded: boolean
  qrData: { key: string; qrimg: string } | null
  qrStatus: { status: number; message: string } | null
  qrPlatform: 'tencent'
  isQrLoading: boolean
  requestQrCode: (platform: string) => void
  checkQrStatus: (key: string) => void
  setCookie: (platform: string, cookie: string) => void
  logout: (platform: string) => void
  resetQr: () => void
}

const authState = vi.hoisted(() => ({
  value: {
    platformStatus: [],
    myStatus: [],
    statusLoaded: true,
    qrData: { key: 'qr-key', qrimg: 'data:image/png;base64,AAAA' },
    qrStatus: { status: 801, message: '等待扫码' },
    qrPlatform: 'tencent',
    isQrLoading: false,
    requestQrCode: () => {},
    checkQrStatus: () => {},
    setCookie: () => {},
    logout: () => {},
    resetQr: () => {},
  } as AuthState,
}))

vi.mock('@/hooks/useAuth', () => ({
  // 故意每次调用都返回新的函数引用，等价于「调用处以内联箭头函数传参」，
  // 这是线上事故里回调身份不稳定的真实形态。
  useAuth: () => ({
    ...authState.value,
    checkQrStatus: (key: string) => authState.value.checkQrStatus(key),
    requestQrCode: (platform: string) => authState.value.requestQrCode(platform),
  }),
}))

vi.mock('@/hooks/usePlaylist', () => ({
  usePlaylist: () => ({
    myPlaylists: { netease: [], tencent: [], kugou: [], bilibili: [], bandcamp: [] },
    playlistsLoading: { netease: false, tencent: false, kugou: false, bilibili: false, bandcamp: false },
    fetchMyPlaylists: () => {},
    playlistTracks: [],
    tracksLoading: false,
    playlistError: null,
    loadingMore: false,
    hasMoreTracks: false,
    playlistTotal: 0,
    playlistSearchTracks: [],
    playlistSearchTotal: 0,
    playlistSearchPage: 1,
    playlistSearchHasMore: false,
    playlistSearchLoading: false,
    playlistSearchError: null,
    fetchPlaylistTracks: () => {},
    addTrackToQueue: () => {},
    insertTrackAfterCurrent: () => {},
    addBatchToQueue: () => {},
    addBatchToDefaultQueue: () => {},
    loadMoreTracks: () => {},
    searchPlaylistTracks: () => {},
    clearPlaylistSearch: () => {},
  }),
}))

vi.mock('@/hooks/usePlatformAutoSwitch', () => ({
  usePlatformAutoSwitch: () => ({ preferredSearchPlatform: null, preferredSettingsPlatform: null }),
}))

import { PlatformHub } from './PlatformHub'

describe('PlatformHub QR polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    authState.value.checkQrStatus = vi.fn<AuthState['checkQrStatus']>()
    authState.value.requestQrCode = vi.fn<AuthState['requestQrCode']>()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  /** 打开二维码弹窗（与真实用户路径一致：点平台卡片上的扫码按钮） */
  function openQrDialog() {
    const buttons = screen.getAllByTitle('扫码登录')
    act(() => {
      fireEvent.click(buttons[0])
    })
  }

  it('polls the QR status even while the room keeps re-rendering', () => {
    const { rerender } = render(<PlatformHub />)
    openQrDialog()
    expect(screen.getByText('QQ 音乐扫码登录')).toBeTruthy()

    // 模拟繁忙房间：PlatformHub 因为房间事件每 100ms 重渲染一次
    for (let i = 0; i < 40; i++) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      rerender(<PlatformHub />)
    }

    // 4 秒过去，2s 的轮询至少应该打到服务端一次
    const checkQrStatus = authState.value.checkQrStatus as unknown as ReturnType<typeof vi.fn>
    expect(checkQrStatus.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(checkQrStatus).toHaveBeenCalledWith('qr-key')
  })

  it('shows the waiting hint while the QR is unscanned', () => {
    render(<PlatformHub />)
    openQrDialog()
    expect(screen.getByText('QQ 音乐扫码登录')).toBeTruthy()
    expect(screen.getByText('打开手机QQ扫码')).toBeTruthy()
    expect(screen.getByAltText('QQ 音乐登录二维码')).toBeTruthy()
  })
})
