/**
 * @fileoverview The WAI-ARIA radio group keys: where each one moves among the cards.
 * @module components/ThemePicker/radioKeys
 */

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown'])
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp'])

/** The index a key moves to from `index` among `count` cards (wrapping), or null for any other key. */
export function targetIndex(key: string, index: number, count: number): number | null {
  if (NEXT_KEYS.has(key)) return (index + 1) % count
  if (PREVIOUS_KEYS.has(key)) return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
