import type { Playlist, MusicSource } from '@music-together/shared'
import * as neteaseAuth from './neteaseAuthService.js'
import * as kugouAuth from './kugouAuthService.js'
import * as tencentAuth from './tencentAuthService.js'

// ---------------------------------------------------------------------------
// 统一认证服务接口
// ---------------------------------------------------------------------------

/**
 * 用户信息数据（三平台通用）
 */
export interface UserInfoData {
  nickname: string
  vipType: number
  userId: number
  /**
   * 凭证有效性是否已被上游**明确确认**。
   *
   * - `true`：上游确认凭证可用（QQ 走 GetLoginUserInfo，code=0）
   * - `false`：无法确认（网络错误 / 风控 500003 等），**不代表凭证已过期**
   * - `undefined`：该平台不做此区分（网易云、酷狗）
   *
   * 用于 UI 区分「已登录」与「登录状态待确认」，避免把未确认显示成正常。
   */
  credentialVerified?: boolean
  /**
   * 服务端在校验过程中更新过的凭证（如 QQ musickey 主动续期后的新 Cookie）。
   *
   * 存在时调用方**必须**用它替换客户端持有的旧 Cookie，否则续期结果会丢失，
   * 下一次进房仍会拿旧凭证去试探。
   */
  refreshedCookie?: string
}

/**
 * getUserInfo 统一返回类型
 * - ok=true: 验证成功，包含用户信息
 * - ok=false + reason='expired': Cookie 已过期（必须由上游**明确**拒绝才可返回，
 *   仅凭「拿不到 VIP 信息」或网络异常不得判为过期——否则会把有效用户误判掉）
 * - ok=false + reason='no_token': 缺少 token/userid（如手动输入了无效 Cookie）
 * - ok=false + reason='error': 临时错误（网络/超时等）
 */
export type GetUserInfoResult =
  | { ok: true; data: UserInfoData }
  | { ok: false; reason: 'expired' | 'error' | 'no_token' }

/**
 * 每个音乐平台认证服务必须实现的接口
 */
export interface AuthProvider {
  /** 生成 QR 扫码登录二维码 */
  generateQrCode(): Promise<{ key: string; qrimg: string } | null>

  /** 检查 QR 扫码状态 */
  checkQrStatus(key: string): Promise<{
    status: number
    message: string
    cookie?: string
  }>

  /** 验证 Cookie 并获取用户信息 */
  getUserInfo(cookie: string): Promise<GetUserInfoResult>

  /** 获取用户歌单列表 */
  getUserPlaylists(cookie: string): Promise<Playlist[]>
}

// ---------------------------------------------------------------------------
// 平台策略映射
// ---------------------------------------------------------------------------

/**
 * 平台 → AuthProvider 映射表
 *
 * authController 通过此映射表获取对应平台的认证服务实例，
 * 从而用一份代码处理所有平台的 QR 登录/Cookie 验证/歌单获取。
 */
export const AUTH_PROVIDERS: Record<Exclude<MusicSource, 'bilibili' | 'bandcamp'>, AuthProvider> = {
  netease: neteaseAuth,
  kugou: kugouAuth,
  tencent: tencentAuth,
}
