import { describe, expect, it } from 'vitest'
import { requiredVoteCount } from './vote.js'

describe('requiredVoteCount', () => {
  it('returns the smallest integer meeting the ratio (>= semantics)', () => {
    expect(requiredVoteCount(5, 0.2)).toBe(1) // 1/5 = 20%
    expect(requiredVoteCount(5, 0.25)).toBe(2) // 1/5 = 20% < 25%
    expect(requiredVoteCount(5, 0.3)).toBe(2) // 1.5 → 2
    expect(requiredVoteCount(5, 0.5)).toBe(3) // 2.5 → 3
    expect(requiredVoteCount(5, 0.67)).toBe(4) // 3.35 → 4
    expect(requiredVoteCount(1, 0.5)).toBe(1)
    expect(requiredVoteCount(3, 1)).toBe(3)
  })

  it('always requires at least one vote and tolerates exact ratios', () => {
    expect(requiredVoteCount(5, 0.01)).toBe(1)
    expect(requiredVoteCount(0, 0.5)).toBe(1)
    expect(requiredVoteCount(4, 0.25)).toBe(1) // 4×0.25 = 1.0（浮点精确整除）
  })
})
