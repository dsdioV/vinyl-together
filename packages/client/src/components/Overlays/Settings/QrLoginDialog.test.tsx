// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QR_STATUS, QR_TIMING } from '@music-together/shared'
import { QrLoginDialog } from './QrLoginDialog'

const QR_DATA = { key: 'qr-key', qrimg: 'data:image/png;base64,AAAA' }

function renderDialog(props: {
  onCheckStatus: (key: string) => void
  qrStatus?: { status: number; message: string } | null
  open?: boolean
}) {
  return render(
    <QrLoginDialog
      open={props.open ?? true}
      onOpenChange={() => {}}
      platform="tencent"
      qrData={QR_DATA}
      qrStatus={props.qrStatus ?? { status: QR_STATUS.WAITING_SCAN, message: '等待扫码' }}
      isLoading={false}
      onRefresh={() => {}}
      onCheckStatus={props.onCheckStatus}
    />,
  )
}

describe('QrLoginDialog polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls the QR status while open', () => {
    const onCheckStatus = vi.fn()
    renderDialog({ onCheckStatus })

    act(() => {
      vi.advanceTimersByTime(QR_TIMING.POLL_INTERVAL_MS * 3)
    })

    expect(onCheckStatus).toHaveBeenCalledTimes(3)
    expect(onCheckStatus).toHaveBeenCalledWith('qr-key')
  })

  // 回归测试：用户扫码并在手机确认后，网站没有任何反应。
  // PlatformHub 以内联箭头函数传入 onCheckStatus，每次渲染都是新引用；
  // 修复前它位于轮询 effect 的依赖数组中，繁忙房间的重渲染会把 2s 定时器
  // 反复清掉重建，服务端一次 AUTH_CHECK_QR 都收不到。
  it('keeps polling when the parent re-renders more often than the interval', () => {
    const onCheckStatus = vi.fn()
    const { rerender } = renderDialog({ onCheckStatus })

    for (let i = 0; i < 40; i++) {
      act(() => {
        vi.advanceTimersByTime(100)
      })
      rerender(
        <QrLoginDialog
          open
          onOpenChange={() => {}}
          platform="tencent"
          qrData={QR_DATA}
          qrStatus={{ status: QR_STATUS.WAITING_SCAN, message: `等待扫码 ${i}` }}
          isLoading={false}
          onRefresh={() => {}}
          onCheckStatus={(key) => onCheckStatus(key)}
        />,
      )
    }

    // 4 秒过去，2s 轮询至少应触发一次；修复前这里是 0 次
    expect(onCheckStatus.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('stops polling once the QR expires', () => {
    const onCheckStatus = vi.fn()
    const { rerender } = renderDialog({ onCheckStatus })

    act(() => {
      vi.advanceTimersByTime(QR_TIMING.POLL_INTERVAL_MS)
    })
    expect(onCheckStatus).toHaveBeenCalledTimes(1)

    rerender(
      <QrLoginDialog
        open
        onOpenChange={() => {}}
        platform="tencent"
        qrData={QR_DATA}
        qrStatus={{ status: QR_STATUS.EXPIRED, message: '二维码已过期' }}
        isLoading={false}
        onRefresh={() => {}}
        onCheckStatus={onCheckStatus}
      />,
    )

    act(() => {
      vi.advanceTimersByTime(QR_TIMING.POLL_INTERVAL_MS * 5)
    })
    expect(onCheckStatus).toHaveBeenCalledTimes(1)
  })

  it('stops polling after a successful login', () => {
    const onCheckStatus = vi.fn()
    const { rerender } = renderDialog({ onCheckStatus })

    act(() => {
      vi.advanceTimersByTime(QR_TIMING.POLL_INTERVAL_MS)
    })
    expect(onCheckStatus).toHaveBeenCalledTimes(1)

    rerender(
      <QrLoginDialog
        open
        onOpenChange={() => {}}
        platform="tencent"
        qrData={QR_DATA}
        qrStatus={{ status: QR_STATUS.SUCCESS, message: '登录成功' }}
        isLoading={false}
        onRefresh={() => {}}
        onCheckStatus={onCheckStatus}
      />,
    )

    act(() => {
      vi.advanceTimersByTime(QR_TIMING.POLL_INTERVAL_MS * 5)
    })
    expect(onCheckStatus).toHaveBeenCalledTimes(1)
  })
})
