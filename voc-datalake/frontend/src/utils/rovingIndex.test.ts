import { describe, expect, it } from 'vitest'
import { MENU_KEYS, RADIO_KEYS, rovingIndex, TAB_KEYS } from './rovingIndex'

describe('rovingIndex', () => {
  it.each([
    ['ArrowDown', 0, 1], ['ArrowDown', 2, 0], ['ArrowUp', 0, 2], ['Home', 2, 0], ['End', 0, 2],
  ])('a menu moves %s from %i to %i (wrapping)', (key, from, to) => {
    expect(rovingIndex(key, from, 3, MENU_KEYS)).toBe(to)
  })

  it('a menu ignores Left/Right and a tablist ignores Up/Down', () => {
    expect(rovingIndex('ArrowRight', 0, 3, MENU_KEYS)).toBeNull()
    expect(rovingIndex('ArrowDown', 0, 3, TAB_KEYS)).toBeNull()
    expect(rovingIndex('ArrowLeft', 0, 3, TAB_KEYS)).toBe(2)
  })

  it('a radio group moves on both axes', () => {
    expect(rovingIndex('ArrowRight', 1, 3, RADIO_KEYS)).toBe(2)
    expect(rovingIndex('ArrowDown', 2, 3, RADIO_KEYS)).toBe(0)
    expect(rovingIndex('ArrowUp', 0, 3, RADIO_KEYS)).toBe(2)
    expect(rovingIndex('a', 0, 3, RADIO_KEYS)).toBeNull()
  })
})
