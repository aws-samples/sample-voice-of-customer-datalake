/**
 * CanvasController: the menus register after the text shows (CanvasChrome.tsx loads later), so a shortcut pressed in
 * between waits for its component and is answered once it registers; afterwards each call goes straight through.
 */
import { describe, expect, it, vi } from 'vitest'
import { CanvasController, SHORTCUT_WAIT_MS } from './controller'

describe('CanvasController', () => {
  it('opens the link editor asked for before it registered, once, when it registers', () => {
    const controller = new CanvasController()
    const open = vi.fn<() => void>()
    controller.openLink()
    controller.openLink()

    controller.setOpenLink(open)
    controller.setOpenLink(null)
    controller.setOpenLink(open)

    expect(open).toHaveBeenCalledTimes(1)
    controller.openLink()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('moves focus to the format bar asked for before it registered, once', () => {
    const controller = new CanvasController()
    const focus = vi.fn<() => void>()
    controller.focusToolbar()

    controller.setFocusToolbar(focus)
    controller.setFocusToolbar(focus)

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('opens the block menu of the block at the caret when the menu registers (read then, not when asked)', () => {
    const controller = new CanvasController()
    const open = vi.fn<(pos: number) => void>()
    const caret = { block: 3 }
    controller.openBlockMenuOf(() => caret.block)
    caret.block = 12

    controller.setOpenBlockMenu(open)

    expect(open).toHaveBeenCalledExactlyOnceWith(12)
    controller.openBlockMenuOf(() => 20)
    controller.openBlockMenu(7)
    expect(open.mock.calls).toStrictEqual([[12], [20], [7]])
  })

  it('opens no block menu when the caret has left every block by then, and the grip waits for nothing', () => {
    const controller = new CanvasController()
    const open = vi.fn<(pos: number) => void>()
    controller.openBlockMenuOf(() => null)
    controller.openBlockMenu(5)

    controller.setOpenBlockMenu(open)

    expect(open).not.toHaveBeenCalled()
  })

  it('drops a shortcut its menu registers for too late (the person has moved on)', () => {
    vi.useFakeTimers()
    try {
      const controller = new CanvasController()
      const [open, focus, menu] = [vi.fn<() => void>(), vi.fn<() => void>(), vi.fn<(pos: number) => void>()]
      controller.openLink()
      controller.focusToolbar()
      controller.openBlockMenuOf(() => 4)
      vi.advanceTimersByTime(SHORTCUT_WAIT_MS + 1)

      controller.setOpenLink(open)
      controller.setFocusToolbar(focus)
      controller.setOpenBlockMenu(menu)

      expect([open, focus, menu].map((fn) => fn.mock.calls.length)).toStrictEqual([0, 0, 0])
      controller.openLink()
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a shortcut its menu registers for in time', () => {
    vi.useFakeTimers()
    try {
      const controller = new CanvasController()
      const open = vi.fn<() => void>()
      controller.openLink()
      vi.advanceTimersByTime(SHORTCUT_WAIT_MS)
      controller.setOpenLink(open)
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the pointer last noted over the canvas', () => {
    const controller = new CanvasController()
    expect(controller.lastPointer()).toBeNull()
    controller.setPointer({ x: 4, y: 9, buttons: 0 })
    expect(controller.lastPointer()).toStrictEqual({ x: 4, y: 9, buttons: 0 })
    controller.setPointer(null)
    expect(controller.lastPointer()).toBeNull()
  })
})
