import { describe, expect, it } from 'vitest'
import { clamp } from './clamp'

describe('clamp', () => {
  it('keeps a value within its range, and the floor when the range is empty', () => {
    expect([clamp(5, 0, 10), clamp(-3, 0, 10), clamp(42, 0, 10)]).toStrictEqual([5, 0, 10])
    expect(clamp(7, 12, 4)).toBe(12)
  })
})
