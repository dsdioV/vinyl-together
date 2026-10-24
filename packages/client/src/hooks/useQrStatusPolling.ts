import { useEffect, useRef } from 'react'

interface QrStatusPollingOptions {
  /** 是否应该轮询（对话框打开 + 已拿到二维码） */
  active: boolean
  /** 当前二维码 key，变化时重启轮询 */
  key: string | null | undefined
  /** 轮询间隔（毫秒） */
  intervalMs: number
  /** 每次轮询的回调；允许每次渲染都是新的函数引用 */
  onPoll: (key: string) => void
}

/**
 * 以固定节奏轮询扫码状态。
 *
 * 关键点：定时器的生命周期只取决于 `active` / `key` / `intervalMs`，
 * **不取决于 `onPoll` 的函数引用**。父组件经常以内联箭头函数传入回调，
 * 每次渲染都是新引用；若把它写进 effect 依赖，父组件每次重渲染都会清掉
 * 并重建定时器 —— 只要重渲染比轮询间隔更频繁，定时器就永远不会触发。
 *
 * 这正是「扫码授权后网站没有任何反应」的根因：房间繁忙时父组件持续重渲染，
 * 2s 定时器被反复重建，服务端从未收到过一次 AUTH_CHECK_QR。
 */
export function useQrStatusPolling({ active, key, intervalMs, onPoll }: QrStatusPollingOptions): void {
  const onPollRef = useRef(onPoll)

  // 单独同步最新回调，不参与下面定时器 effect 的依赖
  useEffect(() => {
    onPollRef.current = onPoll
  }, [onPoll])

  useEffect(() => {
    if (!active || !key) return

    const timer = setInterval(() => {
      onPollRef.current(key)
    }, intervalMs)

    return () => clearInterval(timer)
  }, [active, key, intervalMs])
}
