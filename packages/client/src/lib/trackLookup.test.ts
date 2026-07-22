import { describe, expect, it } from 'vitest'
import { trackLookupFailure } from './trackLookup'

describe('trackLookupFailure', () => {
  it('preserves an actionable server error and code', () => {
    expect(
      trackLookupFailure(429, {
        code: 'KUGOU_SECURITY_VERIFICATION_REQUIRED',
        error: '酷狗暂时要求安全验证，请稍后重试',
      }),
    ).toEqual({
      ok: false,
      code: 'KUGOU_SECURITY_VERIFICATION_REQUIRED',
      message: '酷狗暂时要求安全验证，请稍后重试',
    })
  })

  it.each([
    [404, '未找到该歌曲，请检查 ID 或链接是否正确'],
    [429, '酷狗暂时要求安全验证，请稍后重试'],
    [502, '酷狗服务暂时不可用，请稍后重试'],
    [504, '酷狗服务暂时不可用，请稍后重试'],
  ])('provides a safe fallback for HTTP %i', (status, message) => {
    expect(trackLookupFailure(status, null)).toMatchObject({ ok: false, message })
  })

  it('does not display an unexpectedly large upstream response', () => {
    const result = trackLookupFailure(502, { error: 'x'.repeat(201) })
    expect(result).toMatchObject({ ok: false, message: '酷狗服务暂时不可用，请稍后重试' })
  })
})
