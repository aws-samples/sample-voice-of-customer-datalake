/**
 * @fileoverview Tests for toggleSetMember — the expand/collapse Set toggle.
 */
import { describe, it, expect } from 'vitest'
import { toggleSetMember } from './toggleSetMember'

describe('toggleSetMember', () => {
  it('adds a key that is absent', () => {
    expect(toggleSetMember(new Set(['a']), 'b')).toStrictEqual(new Set(['a', 'b']))
  })

  it('removes a key that is present', () => {
    expect(toggleSetMember(new Set(['a', 'b']), 'b')).toStrictEqual(new Set(['a']))
  })

  it('leaves the input set untouched', () => {
    const input = new Set(['a'])
    toggleSetMember(input, 'a')
    expect(input).toStrictEqual(new Set(['a']))
  })
})
