import { createRequire } from 'node:module'
import { logger } from '../utils/logger.js'

const require = createRequire(import.meta.url)

let ready: Promise<void> | null = null

/**
 * NeteaseCloudMusicApi Enhanced v4.38+ relies on process-local xeapi public key
 * and anonymous token files under os.tmpdir(). The standalone app generates them
 * via generateConfig(); our embedded usage must do the same once per process.
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
