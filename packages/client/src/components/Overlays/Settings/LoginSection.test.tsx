// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MyPlatformAuth, PlatformAuthStatus } from '@music-together/shared'
import { LoginSection } from './LoginSection'

/**
 * 登录状态三态渲染回归测试。
 *
 * 事故背景（2026-11-13）：QQ 凭证过期后，`vip_login_base` 静默返回全零，
 * 服务端把过期凭证当成「已登录的非 VIP 用户」，UI 显示昵称但没有 VIP 徽章。
 * 用户完全无法判断到底是「没开 VIP」还是「登录过期」。
 *
 * 修复后：过期必须显式标注「登录已过期 / 需重新扫码」，并提供重新扫码入口。
 */

// 本仓库未启用 vitest globals，testing-library 不会自动清理，需手动 cleanup
afterEach(cleanup)

const noop = () => {}
const baseProps = {
  platform: 'tencent' as const,
  onQrLogin: noop,
  onCookieLogin: noop,
  onLogout: noop,
}

function status(overrides: Partial<PlatformAuthStatus> = {}): PlatformAuthStatus {
  return { platform: 'tencent', loggedInCount: 1, hasVip: true, maxVipType: 2, ...overrides }
}

const NO_VIP_STATUS = status({ loggedInCount: 0, hasVip: false, maxVipType: 0 })

function my(overrides: Partial<MyPlatformAuth> = {}): MyPlatformAuth {
  return { platform: 'tencent', loggedIn: true, nickname: 'Voidsd', vipType: 2, ...overrides }
}

const NOT_LOGGED_IN = my({ loggedIn: false, nickname: undefined, vipType: undefined })

describe('LoginSection', () => {
  it('shows the nickname and VIP badge for a healthy login', () => {
    render(<LoginSection {...baseProps} status={status()} myStatus={my()} />)

    expect(screen.getByText('Voidsd')).toBeTruthy()
    expect(screen.getByText('豪华VIP')).toBeTruthy()
    expect(screen.queryByText('登录已过期')).toBeNull()
  })

  // ===== 本次事故的核心回归 =====
  // 过期绝不能渲染成「已登录但没有 VIP」，否则用户永远不知道要重新扫码。
  it('labels an expired credential explicitly instead of showing a plain login', () => {
    render(
      <LoginSection
        {...baseProps}
        status={NO_VIP_STATUS}
        myStatus={my({ loggedIn: false, expired: true, nickname: undefined, vipType: undefined })}
      />,
    )

    expect(screen.getByText('登录已过期')).toBeTruthy()
    expect(screen.getByText('需重新扫码')).toBeTruthy()
    expect(screen.getByText(/登录凭证已失效/)).toBeTruthy()
    // 过期时提供「重新扫码」，而不是让用户自己找入口
    expect(screen.getByRole('button', { name: /重新扫码/ })).toBeTruthy()
    // 不应显示昵称（凭证已不可信，显示昵称会让人以为登录还生效）
    expect(screen.queryByText('Voidsd')).toBeNull()
  })

  it('offers both QR and cookie login when the user never logged in', () => {
    render(<LoginSection {...baseProps} status={NO_VIP_STATUS} myStatus={NOT_LOGGED_IN} />)

    expect(screen.getByText('未登录')).toBeTruthy()
    expect(screen.getByTitle('扫码登录')).toBeTruthy()
    expect(screen.getByTitle('Cookie 登录')).toBeTruthy()
    expect(screen.queryByText('登录已过期')).toBeNull()
  })

  it('flags an unconfirmed credential without pretending it is fully healthy', () => {
    render(<LoginSection {...baseProps} status={status()} myStatus={my({ credentialVerified: false })} />)

    expect(screen.getByText('Voidsd')).toBeTruthy()
    expect(screen.getByText('状态待确认')).toBeTruthy()
    expect(screen.getByText(/凭证状态未能确认/)).toBeTruthy()
  })

  it('shows "verifying" while the first status response is still pending', () => {
    render(<LoginSection {...baseProps} status={undefined} myStatus={undefined} isVerifying />)

    expect(screen.getByText('验证登录中…')).toBeTruthy()
  })
})
