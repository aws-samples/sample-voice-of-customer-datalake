import { describe, expect, it, vi } from 'vitest'
import { moveOnArrowKeys } from './reorderKeys'

/** A keydown as React hands it to the list item, with its preventDefault spied. */
function keydown(key: string, modifiers: { altKey?: boolean; shiftKey?: boolean } = { altKey: true, shiftKey: true }) {
  const preventDefault = vi.fn<() => void>()
  const event = { key, altKey: modifiers.altKey === true, shiftKey: modifiers.shiftKey === true, preventDefault }
  return { event, preventDefault }
}

describe('moveOnArrowKeys', () => {
  it('moves the item one place up or down on Alt+Shift+Arrow', () => {
    const onMove = vi.fn<(to: number) => void>()
    moveOnArrowKeys(keydown('ArrowUp').event, 2, 4, onMove)
    moveOnArrowKeys(keydown('ArrowDown').event, 2, 4, onMove)
    expect(onMove.mock.calls).toStrictEqual([[1], [3]])
  })

  it('never moves past either end, and leaves the key to the page then', () => {
    const onMove = vi.fn<(to: number) => void>()
    const up = keydown('ArrowUp')
    moveOnArrowKeys(up.event, 0, 3, onMove)
    moveOnArrowKeys(keydown('ArrowDown').event, 2, 3, onMove)
    expect(onMove).not.toHaveBeenCalled()
    expect(up.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores an arrow without both Alt and Shift', () => {
    const onMove = vi.fn<(to: number) => void>()
    moveOnArrowKeys(keydown('ArrowUp', { altKey: true }).event, 1, 3, onMove)
    moveOnArrowKeys(keydown('ArrowUp', { shiftKey: true }).event, 1, 3, onMove)
    expect(onMove).not.toHaveBeenCalled()
  })
})
