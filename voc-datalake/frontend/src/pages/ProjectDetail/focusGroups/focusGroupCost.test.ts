import { describe, expect, it } from 'vitest'
import { focusGroupCost } from './focusGroupCost'

describe('focusGroupCost', () => {
  it('counts every persona each round, a moderator call before rounds 2 and 3, and the synthesis', () => {
    expect(focusGroupCost(6, 2)).toStrictEqual({ calls: 14, inputTokens: 45_000, outputTokens: 8_000 })
    expect(focusGroupCost(2, 1).calls).toBe(3)
    expect(focusGroupCost(6, 3).calls).toBe(21)
  })

  it('never estimates under a thousand tokens', () => {
    expect(focusGroupCost(0, 1)).toStrictEqual({ calls: 1, inputTokens: 1_000, outputTokens: 1_000 })
  })
})
