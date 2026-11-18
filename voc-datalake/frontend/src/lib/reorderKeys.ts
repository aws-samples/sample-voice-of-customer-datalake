/**
 * @fileoverview The keyboard path of a reorderable list, beside drag and drop: Alt+Shift+↑ / ↓ moves the focused item
 * one place (the prototype walkthrough's steps, the forms builder's questions, endings and options).
 * @module lib/reorderKeys
 */
import type { KeyboardEvent } from 'react'

/** What the move reads of a keydown. */
type ArrowKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'preventDefault'>

/** On Alt+Shift+ArrowUp / ArrowDown, move the item at `index` of `total` one place (never past either end). */
export function moveOnArrowKeys(event: ArrowKey, index: number, total: number, onMove: (to: number) => void): void {
  if (!event.altKey || !event.shiftKey) return
  if (event.key === 'ArrowUp' && index > 0) {
    event.preventDefault()
    onMove(index - 1)
  }
  if (event.key === 'ArrowDown' && index < total - 1) {
    event.preventDefault()
    onMove(index + 1)
  }
}
