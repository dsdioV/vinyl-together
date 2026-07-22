import crypto from 'node:crypto'
import QRCode from 'qrcode'
import type { Playlist } from '@music-together/shared'
import type { GetUserInfoResult, UserInfoData } from './authProvider.js'
import { logger } from '../utils/logger.js'
import { parseCookieString } from '../utils/cookieUtils.js'

/**
 * Kugou Music authentication service.
 * Self-contained implementation extracted from MakcRe/KuGouMusicApi.
 * Handles QR code login, status polling, user info, VIP, and playlists.
 */

// ---------------------------------------------------------------------------
// Constants (from KuGouMusicApi config)
// ---------------------------------------------------------------------------

const APPID = 1005
const SRCAPPID = 2919
const CLIENTVER = 20489

const WEB_SIGNATURE_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const ANDROID_SIGNATURE_SALT = 'OIlwieks28dk2k092lksi2UIkp'

const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/g
bjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+
UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE
5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function md5(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex')
}

function signatureWebParams(params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .map((key) => `${key}=${params[key]}`)
    .sort()
    .join('')
  return md5(`${WEB_SIGNATURE_SALT}${sorted}${WEB_SIGNATURE_SALT}`)
}

function signatureAndroidParams(params: Record<string, unknown>, data?: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => {
      const val = params[key]
      return `${key}=${typeof val === 'object' ? JSON.stringify(val) : val}`
    })
    .join('')
  return md5(`${ANDROID_SIGNATURE_SALT}${sorted}${data || ''}${ANDROID_SIGNATURE_SALT}`)
}

/**
 * RSA encrypt with NO_PADDING (required by Kugou user_detail API).
 * Input is padded to 128 bytes before encryption.
 */
function rsaEncrypt(data: string | Record<string, unknown>): string {
  const str = typeof data === 'object' ? JSON.stringify(data) : data
  const buffer = Buffer.from(str)
  const padded = Buffer.concat([buffer, Buffer.alloc(128 - buffer.length)])
  return crypto.publicEncrypt({ key: RSA_PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex')
}

function randomString(len = 16): string {
  const chars = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let result = ''
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

function getGuid(): string {
  const s = () => ((65536 * (1 + Math.random())) | 0).toString(16).substring(1)
  return `${s()}${s()}-${s()}-${s()}-${s()}-${s()}${s()}${s()}`
}

function calculateMid(str: string): string {
  let bigInt = BigInt(0)
  const base = BigInt(16)
  const digest = md5(str)
  const len = digest.length
  for (let i = 0; i < len; i++) {
    const charValue = BigInt(parseInt(digest.charAt(i), 16))
    const power = base ** BigInt(len - 1 - i)
    bigInt += charValue * power
  }
  return bigInt.toString()
}

const GUID = md5(getGuid())
const MID = calculateMid(GUID)

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------

interface KugouRequestConfig {
  baseURL: string
  url: string
  method?: 'GET' | 'POST'
  params: Record<string, unknown>
  data?: Record<string, unknown>
  encryptType: 'web' | 'android'
  cookie?: Record<string, string>
  headers?: Record<string, string>
  clearDefaultParams?: boolean
}

/** Kugou API response (loosely typed — external API). */
interface KugouApiResponse {
  status?: number
  error_code?: number
  data?: Record<string, unknown> | any[]
  [key: string]: unknown
}

async function kugouRequest(config: KugouRequestConfig): Promise<KugouApiResponse> {
  const clienttime = Math.floor(Date.now() / 1000)
  const dfid = config.cookie?.dfid || '-'
  const method = config.method || 'GET'

  const defaultParams: Record<string, unknown> = config.clearDefaultParams ? {} : {
    dfid,
    mid: config.cookie?.mid || MID,
    uuid: config.cookie?.mid || config.cookie?.uuid || '-',
    appid: APPID,
    clientver: CLIENTVER,
    clienttime,
  }

  // Accept both QR-login format (token/userid) and browser-cookie format (t/KugooID)
  const cookieToken = config.cookie?.token || config.cookie?.t
  const cookieUserid = config.cookie?.userid || config.cookie?.KugooID
  if (!config.clearDefaultParams) {
    if (cookieToken) defaultParams['token'] = cookieToken
    if (cookieUserid && cookieUserid !== '0') {
      defaultParams['userid'] = cookieUserid
    }
  }

  const merged = { ...defaultParams, ...config.params }

  // Stringify POST body (needed for Android signature)
  const bodyStr = config.data ? JSON.stringify(config.data) : ''

  // Compute signature
  if (config.encryptType === 'web') {
    merged['signature'] = signatureWebParams(merged)
  } else {
    merged['signature'] = signatureAndroidParams(merged, bodyStr)
  }

  const qs = Object.keys(merged)
    .sort()
    .map((k) => {
      const v = merged[k]
      return `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`
    })
    .join('&')

  const fullUrl = `${config.baseURL}${config.url}?${qs}`

  const headers: Record<string, string> = {
    'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    dfid,
    clienttime: String(clienttime),
    mid: MID,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    ...config.headers,
  }

  const fetchOpts: RequestInit = { method, headers }
  if (method === 'POST' && bodyStr) {
    headers['Content-Type'] = 'application/json'
    fetchOpts.body = bodyStr
  }

  const res = await fetch(fullUrl, fetchOpts)

  if (!res.ok) {
    throw new Error(`Kugou API HTTP ${res.status} ${res.statusText}: ${config.url}`)
  }

  let body: KugouApiResponse
  try {
    body = (await res.json()) as KugouApiResponse
  } catch {
    throw new Error(`Kugou API JSON parse failed: ${config.url} (HTTP ${res.status})`)
  }

  return body
}

// ---------------------------------------------------------------------------
// QR Code Login
// ---------------------------------------------------------------------------

export async function generateQrCode(): Promise<{ key: string; qrimg: string } | null> {
  try {
    const body = await kugouRequest({
      baseURL: 'https://login-user.kugou.com',
      url: '/v2/qrcode',
      params: {
        appid: APPID,
        type: 1,
        plat: 4,
        qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APPID}&`,
        srcappid: SRCAPPID,
      },
      encryptType: 'web',
    })

    const qrData = body?.data as Record<string, unknown> | undefined
    const key = qrData?.qrcode as string | undefined
    if (!key) {
      logger.error('Kugou QR: failed to get qrcode key', body)
      return null
    }

    const qrUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`
    const qrimg = await QRCode.toDataURL(qrUrl, { width: 280, margin: 2 })

    logger.info('Kugou QR code generated')
    return { key, qrimg }
  } catch (err) {
    logger.error('Kugou QR generation failed', err)
    return null
  }
}

const STATUS_MAP: Record<number, number> = {
  0: 800,
  1: 801,
  2: 802,
  4: 803,
}

const STATUS_MESSAGES: Record<number, string> = {
  800: '二维码已过期，请重新获取',
  801: '等待扫码',
  802: '已扫码，等待确认',
  803: '登录成功',
}

export async function checkQrStatus(key: string): Promise<{
  status: number
  message: string
  cookie?: string
}> {
  try {
    const body = await kugouRequest({
      baseURL: 'https://login-user.kugou.com',
      url: '/v2/get_userinfo_qrcode',
      params: {
        plat: 4,
        appid: APPID,
        srcappid: SRCAPPID,
        qrcode: key,
      },
      encryptType: 'web',
    })

    const d = body?.data as Record<string, unknown> | undefined
    const rawStatus = Number(d?.status ?? 0)
    const status = STATUS_MAP[rawStatus] ?? 800
    const message = STATUS_MESSAGES[status] ?? `未知状态 (${rawStatus})`

    if (status === 803 && d?.token && d?.userid) {
      const token = String(d.token)
      const userid = String(d.userid)
      // Capture device identifiers from login response — the wwwapi
      // endpoint validates mid/dfid against the token's origin session.
      const mid = String(d.mid || d.kg_mid || '')
      const dfid = String(d.dfid || d.kg_dfid || '')
      logger.info(`Kugou QR login: token=${token.slice(0,8)}... userid=${userid} mid=${mid} dfid=${dfid}`)
      // Store all auth fields in the cookie string
      const parts = [`token=${token}`, `userid=${userid}`]
      if (mid) parts.push(`mid=${mid}`)
      if (dfid) parts.push(`dfid=${dfid}`)
      const cookie = parts.join(';')
      return { status, message, cookie }
    }

    return { status, message }
  } catch (err) {
    logger.error('Kugou QR check failed', err)
    return { status: 800, message: '检查状态失败' }
  }
}

// ---------------------------------------------------------------------------
// User Detail (nickname via RSA-encrypted request)
// ---------------------------------------------------------------------------

/**
 * Fetch user nickname from Kugou's user center API.
 * Requires RSA-encrypted auth payload.
 */
async function fetchUserDetail(cookie: Record<string, string>): Promise<string | null> {
  try {
    const token = cookie['token']
    const userid = Number(cookie['userid'] || '0')
    if (!token || !userid) return null

    const clienttime = Math.floor(Date.now() / 1000)
    const pk = rsaEncrypt({ token, clienttime }).toUpperCase()

    const body = await kugouRequest({
      baseURL: 'https://gateway.kugou.com',
      url: '/v3/get_my_info',
      method: 'POST',
      params: { plat: 1 },
      data: {
        visit_time: clienttime,
        usertype: 1,
        p: pk,
        userid,
      },
      encryptType: 'android',
      cookie,
      headers: { 'x-router': 'usercenter.kugou.com' },
    })

    const d = body?.data as Record<string, unknown> | undefined
    const nickname = String(d?.nick_name || d?.nickname || d?.userName || '')
    if (nickname) {
      logger.info(`Kugou user detail: nickname=${nickname}`)
    } else {
      logger.warn('Kugou user detail: no nickname found in response', { keys: Object.keys(d || {}) })
    }
    return nickname || null
  } catch (err) {
    logger.warn('Kugou fetchUserDetail failed (non-critical)', err as Record<string, unknown>)
    return null
  }
}

// ---------------------------------------------------------------------------
// User Info & VIP
// ---------------------------------------------------------------------------

// UserInfoData 和 GetUserInfoResult 从 authProvider.ts 统一导入

/**
 * Validate a Kugou cookie (token+userid) and get VIP info + nickname.
 */
export async function getUserInfo(cookie: string): Promise<GetUserInfoResult> {
  // 使用共享的 parseCookieString（已从 cookieUtils 导入）
  try {
    const cookieObj = parseCookieString(cookie)
    // Accept both QR-login format (token/userid) and browser-cookie format (t/KugooID)
    const token = cookieObj['token'] || cookieObj['t']
    const userid = cookieObj['userid'] || cookieObj['KugooID']

    if (!token || !userid) {
      logger.warn('Kugou getUserInfo: missing token/t and userid/KugooID in cookie')
      return { ok: false, reason: 'no_token' }
    }

    // Fetch VIP info
    const body = await kugouRequest({
      baseURL: 'https://kugouvip.kugou.com',
      url: '/v1/get_union_vip',
      params: { busi_type: 'concept' },
      encryptType: 'android',
      cookie: { token, userid },
    })

    if (!body?.data) {
      logger.warn('Kugou getUserInfo: no data in VIP response', body)
      return { ok: false, reason: 'expired' }
    }

    const vipData = body.data as Record<string, unknown>
    const isVip = vipData.is_vip === 1 || Number(vipData.vip_type) > 0
    const vipType = isVip ? Number(vipData.vip_type) || 1 : 0

    // Fetch nickname (non-blocking — fallback to userid if failed)
    const nickname = await fetchUserDetail({ token, userid })

    return {
      ok: true,
      data: {
        nickname: nickname || `酷狗用户${userid}`,
        vipType,
        userId: Number(userid),
      },
    }
  } catch (err) {
    logger.error('Kugou getUserInfo failed (transient error)', err)
    return { ok: false, reason: 'error' }
  }
}

// ---------------------------------------------------------------------------
// User Playlists
// ---------------------------------------------------------------------------

/**
 * Fetch user's playlist list from Kugou.
 */
export async function getUserPlaylists(cookie: string): Promise<Playlist[]> {
  try {
    const cookieObj = parseCookieString(cookie)
    const token = cookieObj['token']
    const userid = cookieObj['userid']

    if (!token || !userid) {
      logger.warn('Kugou getUserPlaylists: missing token or userid')
      return []
    }

    const body = await kugouRequest({
      baseURL: 'https://gateway.kugou.com',
      url: '/v7/get_all_list',
      method: 'POST',
      params: { plat: 1, userid: Number(userid), token },
      data: {
        userid: Number(userid),
        token,
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 100,
      },
      encryptType: 'android',
      cookie: { token, userid },
      headers: { 'x-router': 'cloudlist.service.kugou.com' },
    })

    const d = body?.data as Record<string, unknown> | undefined
    const lists = d?.info
    if (!Array.isArray(lists)) {
      logger.warn('Kugou getUserPlaylists: unexpected response', { keys: Object.keys(d || {}) })
      return []
    }

    const mapped: Playlist[] = lists.map((p: Record<string, unknown>) => ({
      id: String(p.global_collection_id || p.listid || p.dirid || ''),
      name: String(p.name || ''),
      cover: String(p.pic || p.img || ''),
      trackCount: Number(p.count ?? p.total ?? 0),
      source: 'kugou' as const,
    }))

    logger.info(`Fetched ${mapped.length} playlists for kugou user ${userid}`)
    return mapped
  } catch (err) {
    logger.error('Kugou getUserPlaylists failed', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Playlist Tracks (via global_collection_id)
// ---------------------------------------------------------------------------

export interface KugouPlaylistTrack {
  hash: string
  filename: string
  album_name?: string
  duration?: number
  privilege?: number
  [key: string]: unknown
}

/**
 * Fetch tracks from a kugou user playlist by global_collection_id.
 * Paginated — pass page (1-based) and pagesize.
 * Returns raw song objects for musicProvider to convert.
 */
export async function getPlaylistTracks(
  playlistId: string,
  page = 1,
  pagesize = 300,
  cookie?: string | null,
): Promise<{ songs: KugouPlaylistTrack[]; total: number }> {
  try {
    const cookieObj = cookie ? parseCookieString(cookie) : {}

    const body = await kugouRequest({
      baseURL: 'https://gateway.kugou.com',
      url: '/pubsongs/v2/get_other_list_file_nofilt',
      method: 'GET',
      params: {
        area_code: 1,
        begin_idx: (page - 1) * pagesize,
        plat: 1,
        type: 1,
        mode: 1,
        personal_switch: 1,
        extend_fields: 'abtags,hot_cmt,popularization',
        pagesize,
        global_collection_id: playlistId,
      },
      encryptType: 'android',
      cookie: cookieObj,
    })

    const d = body?.data as Record<string, unknown> | undefined
    const songs = (d?.songs ?? d?.info) as KugouPlaylistTrack[] | undefined
    const total = Number(d?.count ?? d?.total ?? 0)

    if (!Array.isArray(songs) || songs.length === 0) {
      logger.warn('Kugou getPlaylistTracks: no songs found', {
        playlistId,
        total,
        keys: Object.keys(d || {}),
      })
      return { songs: [], total }
    }

    return { songs, total }
  } catch (err) {
    logger.error('Kugou getPlaylistTracks failed', err)
    return { songs: [], total: 0 }
  }
}

// parseCookieString 已移至 utils/cookieUtils.ts 统一管理

// ---------------------------------------------------------------------------
// Play URL Resolution — bypasses @meting/core for kugou
// ---------------------------------------------------------------------------
// The wwwapi.kugou.com endpoint expects a specific appid that must match the
// token's origin:
//   - Browser cookies (t/KugooID) → a_id=1014, clientver=20000 (web player)
//   - QR login cookies (token/userid) → APPID=1005, clientver=20489 (Android)
// Detect the format and use the matching credentials.

export async function getPlayUrl(
  hash: string,
  cookie?: string | null,
): Promise<{ url: string; size: number; br: number }> {
  const empty = { url: '', size: 0, br: -1 }

  try {
    const cookieObj = cookie ? parseCookieString(cookie) : {}
    hash = hash.toLowerCase()

    // Detect cookie format to pick the correct appid
    const isBrowserCookie = !!(cookieObj['t'] || cookieObj['KugooID'])

    if (isBrowserCookie) {
      const wwwapiAppid = cookieObj['a_id']
        ? Number(cookieObj['a_id'])
        : 1014
      const wwwapiClientver = 20000

      // Step 1: get encode_album_audio_id from hash
      const step1 = await kugouRequest({
        baseURL: 'https://wwwapi.kugou.com',
        url: '/play/songinfo',
        params: {
          hash,
          appid: wwwapiAppid,
          platid: '4',
          srcappid: SRCAPPID,
          clientver: wwwapiClientver,
        },
        encryptType: 'web',
        cookie: cookieObj,
      })

      const data1 = step1?.data as Record<string, unknown> | undefined
      const encodeId = data1?.encode_album_audio_id as string | undefined
      if (!encodeId) {
        const step1err = step1?.err_code || step1?.status
        const bodyPreview = JSON.stringify(step1).slice(0, 300)
        logger.warn(
          `Kugou getPlayUrl: step1 failed appid=${wwwapiAppid} clientver=${wwwapiClientver} ` +
          `err_code=${step1err} body=${bodyPreview}`,
        )
        return empty
      }

      // Step 2: get play_url from encode_album_audio_id
      const step2 = await kugouRequest({
        baseURL: 'https://wwwapi.kugou.com',
        url: '/play/songinfo',
        params: {
          encode_album_audio_id: encodeId,
          appid: wwwapiAppid,
          platid: '4',
          srcappid: SRCAPPID,
          clientver: wwwapiClientver,
        },
        encryptType: 'web',
        cookie: cookieObj,
      })

      const data2 = step2?.data as Record<string, unknown> | undefined
      const playUrl = (data2?.play_url || data2?.play_backup_url || '') as string
      const size = Number(data2?.filesize || 0)
      const br = Number(data2?.bitrate || -1)

      if (playUrl) {
        logger.info(`Kugou getPlayUrl: resolved to ${br}kbps`)
        return { url: playUrl, size, br }
      }

      logger.warn('Kugou getPlayUrl: step2 returned no play_url')
      return empty
    } else {
      //使用trackercdn获取Android客户端令牌
      const mid = cookieObj?.mid || MID
      const userid = cookieObj?.userid || '0'
      const signKeyStr = '57ae12eb6890223e355ccfcb74edf70d'
      const key = md5(`${hash}${signKeyStr}${APPID}${mid}${userid}`)

      const res = await kugouRequest({
        baseURL: 'https://trackercdn.kugou.com',
        url: '/v5/url',
        params: {
          album_id: 0,
          area_code: 1,
          hash,
          ssa_flag: 'is_fromtrack',
          version: 11430,
          page_id: 151369488,
          quality: 128,
          album_audio_id: 0,
          behavior: 'play',
          pid: 2,
          cmd: 26,
          pidversion: 3001,
          IsFreePart: 0,
          ppage_id: '463467626,350369493,788954147',
          cdnBackup: 1,
          key,
          appid: APPID,
          clientver: 11430,
        },
        encryptType: 'android',
        cookie: cookieObj,
        headers: {
          'x-router': 'trackercdn.kugou.com',
        }
      })

      if (res.status === 1 && res.url && Array.isArray(res.url) && res.url.length > 0) {
        const br = res.bitRate ? Math.round(Number(res.bitRate) / 1000) : -1
        logger.info(`Kugou getPlayUrl: resolved to ${br}kbps`)
        return {
          url: String(res.url[0]),
          size: Number(res.fileSize) || 0,
          br
        }
      }

      const errCode = res.error_code || res.status
      const bodyPreview = JSON.stringify(res).slice(0, 300)
      logger.warn(
        `Kugou getPlayUrl: trackercdn failed appid=${APPID} err_code=${errCode} body=${bodyPreview}`,
      )
      return empty
    }
  } catch (err) {
    logger.error('Kugou getPlayUrl failed', err)
    return empty
  }
}

export async function getCover(hash: string, cookie?: string | null): Promise<string> {
  try {
    const cookieObj = cookie ? parseCookieString(cookie) : {}
    hash = hash.toLowerCase()

    const data = [{ album_id: 0, hash, album_audio_id: 0 }]
    const reqAppid = cookieObj['a_id']
      ? Number(cookieObj['a_id'])
      : APPID
    const reqClientver = 11430

    const res = await kugouRequest({
      baseURL: 'https://expendablekmr.kugou.com',
      url: '/container/v2/image',
      params: {
        album_image_type: '-3',
        appid: reqAppid,
        clientver: reqClientver,
        author_image_type: '3,4,5',
        count: 1,
        data,
        isCdn: 1,
        publish_time: 1
      },
      encryptType: 'android',
      cookie: cookieObj,
      clearDefaultParams: true
    })

    if (res.status === 1 && res.data && Array.isArray(res.data) && res.data.length > 0) {
      const imgData = res.data[0]
      if (imgData.album && imgData.album[0] && imgData.album[0].sizable_cover) {
        return imgData.album[0].sizable_cover.replace('{size}', '400')
      }
      if (imgData.author && imgData.author[0] && imgData.author[0].sizable_avatar) {
        return imgData.author[0].sizable_avatar.replace('{size}', '400')
      }
    }
    
    logger.warn('Kugou getCover: expected image data missing', { res: JSON.stringify(res).slice(0, 300) })
  } catch (err) {
    logger.error('Kugou getCover failed', err)
  }
  return ''
}
