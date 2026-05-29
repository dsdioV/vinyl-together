/**
 * Cookie 字符串解析工具
 * 统一替代 kugouAuthService 和 tencentAuthService 中的重复实现
 */

/**
 * 将 cookie 字符串解析为 key-value 对象。
 * 自动检测并转换 Netscape HTTP Cookie File 格式（curl 导出格式）。
 * @example parseCookieString('token=abc;userid=123') => { token: 'abc', userid: '123' }
 */
export function parseCookieString(cookie: string): Record<string, string> {
  const normalized = normalizeCookieString(cookie)
  const result: Record<string, string> = {}
  for (const pair of normalized.split(';')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx < 1) continue
    const key = pair.substring(0, eqIdx).trim()
    const value = pair.substring(eqIdx + 1).trim()
    result[key] = value
  }
  return result
}

/**
 * Convert Netscape HTTP Cookie File format to standard `name=value; …` format.
 * Netscape format: each line is `domain\tflag\tpath\tsecure\texpiration\tname\tvalue`.
 * Lines starting with `#` are skipped.
 * If the input is already in standard format (no leading `# Netscape`, no tab-separated
 * cookie lines), it is returned unchanged.
 */
export function normalizeCookieString(raw: string): string {
  const trimmed = raw.trim()
  // Quick check: Netscape format always contains tabs on data lines
  if (!trimmed.includes('\t')) return trimmed

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
  const pairs: string[] = []
  for (const line of lines) {
    // Skip comments
    if (line.startsWith('#')) continue
    // Netscape format: tab-separated, last two fields are name and value
    const parts = line.split('\t')
    if (parts.length >= 7) {
      const name = parts[5].trim()
      const value = parts.slice(6).join('\t').trim()
      if (name && value) {
        pairs.push(`${name}=${value}`)
      }
    }
  }
  // If we parsed at least one pair, return the converted format
  if (pairs.length > 0) return pairs.join(';')
  return trimmed
}

/**
 * 从 cookie 字符串中快速提取单个 key 的值
 * 比 parseCookieString 更高效（无需解析整个字符串）
 * @example getCookieValue('uin=123456; qm_keyst=abc', 'uin') => '123456'
 */
export function getCookieValue(cookie: string, key: string): string | null {
  const regex = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`)
  const match = cookie.match(regex)
  return match ? match[1].trim() : null
}
