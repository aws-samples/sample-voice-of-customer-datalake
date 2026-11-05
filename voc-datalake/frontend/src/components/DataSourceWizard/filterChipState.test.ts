import { describe, expect, it } from 'vitest'
import { toggleArrayItem } from './filterChipState'

describe('toggleArrayItem', () => {
  it('adds an item that is not there and removes one that is', () => {
    expect(toggleArrayItem(['a'], 'b')).toStrictEqual(['a', 'b'])
    expect(toggleArrayItem(['a', 'b'], 'a')).toStrictEqual(['b'])
  })

  it('leaves a full list as it is on an add, and still removes from it', () => {
    expect(toggleArrayItem(['a', 'b'], 'c', 2)).toStrictEqual(['a', 'b'])
    expect(toggleArrayItem(['a', 'b'], 'b', 2)).toStrictEqual(['a'])
  })
})
