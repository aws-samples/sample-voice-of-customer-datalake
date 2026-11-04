/**
 * @fileoverview Roving focus keys of the WAI-ARIA composite widgets: where a key moves
 * among `count` items (wrapping), for a menu (Up/Down), a tablist (Left/Right) or a
 * radio group (both axes). Home and End go to the first and last item.
 * @module utils/rovingIndex
 */

export interface RovingKeys {
  readonly next: readonly string[]
  readonly previous: readonly string[]
}

export const MENU_KEYS: RovingKeys = { next: ['ArrowDown'], previous: ['ArrowUp'] }
export const TAB_KEYS: RovingKeys = { next: ['ArrowRight'], previous: ['ArrowLeft'] }
export const RADIO_KEYS: RovingKeys = { next: ['ArrowRight', 'ArrowDown'], previous: ['ArrowLeft', 'ArrowUp'] }

/** The index `key` moves to from `current`, or null when it is not one of `keys`, Home or End. */
export function rovingIndex(key: string, current: number, count: number, keys: RovingKeys): number | null {
  if (keys.next.includes(key)) return (current + 1) % count
  if (keys.previous.includes(key)) return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
