import { describe, expect, it } from 'vitest'
import { commonPrefixLength } from './commonPrefix'

describe('commonPrefixLength', () => {
  it('counts the characters two texts start with', () => {
    expect(commonPrefixLength('quiet hours', 'quiet time')).toBe(6)
  })

  it('is the shorter length when one text starts the other, and 0 when they differ at once or one is empty', () => {
    expect([commonPrefixLength('abc', 'abcdef'), commonPrefixLength('abc', 'xbc'), commonPrefixLength('', 'abc')])
      .toStrictEqual([3, 0, 0])
  })

  it('counts by UTF-16 unit, as string offsets do', () => {
    // The two emoji share their high surrogate.
    expect(commonPrefixLength('a\u{1F600}', 'a\u{1F601}')).toBe(2)
  })

  it('counts the lines two lists start with', () => {
    expect(commonPrefixLength(['# Plan', 'one', 'two'], ['# Plan', 'one', 'three'])).toBe(2)
  })
})
