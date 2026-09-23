import { createRequire } from 'node:module'
import { logger } from '../utils/logger.js'

const require = createRequire(import.meta.url)

let ready: Promise<void> | null = null

/**
 * NeteaseCloudMusicApi Enhanced v4.38+ relies on process-local xeapi public key
 * and anonymous token files under os.tmpdir(). The standalone app generates them
 * via generateConfig(); our embedded usage must do the same once per process.
 *
 * 与海外部署相关的一点（2026-09 生产实测，别删）：`generateConfig()` 里的
 * `global.cnIp = generateRandomChineseIP()` 只在 `server.js` 的 HTTP 路由层被消费。
 * 本项目走嵌入式入口（`main.js`），`util/request.js` 只认 `options.realIP || options.ip`，
 * 因此：
 * - `global.cnIp` / `randomCNIP` / `ENABLE_RANDOM_CN_IP` 在嵌入式调用中**不会**产生任何
 *   `X-Real-IP` 请求头（实测出站请求完全无该头），对网易云判权零影响；
 * - 真正生效的是每请求显式传入的 `realIP`（见 musicProvider 的 `NETEASE_REAL_IP_FALLBACK`）。
 * 保留 generateConfig() 是为了匿名 token 与 xeapi 公钥，不是因为 IP。
 */
export function ensureNeteaseApiReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig.js')
        await generateConfig()
        logger.info('Netease API bootstrap completed (anonymous token + xeapi public key)')
      } catch (err) {
        // Do not crash the whole server: stream resolution can still degrade gracefully.
        logger.error('Netease API bootstrap failed', err)
      }
    })()
  }
  return ready
}
