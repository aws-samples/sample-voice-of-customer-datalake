/**
 * The shared tooltip timing (docs/kiro-design-system.md › Tooltips): 80 ms in, 0 ms within the delay group,
 * 100 ms out, at once on keyboard focus, never on touch, one tooltip at a time.
 *
 * The fake clock is installed once for the file and only moves forward, because the delay group remembers
 * when the last tooltip closed (module state).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CLOSE_DELAY_MS, OPEN_DELAY_MS, SKIP_DELAY_MS, createTooltipTimer } from './tooltipTiming'
import type { TooltipTimer } from './tooltipTiming'

const created: TooltipTimer[] = []

/** A timer and the list of open states it reported. */
function tooltip(): { timer: TooltipTimer; changes: boolean[] } {
  const changes: boolean[] = []
  const timer = createTooltipTimer((open) => changes.push(open))
  created.push(timer)
  return { timer, changes }
}

beforeAll(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const timer of created.splice(0)) timer.dismiss()
  // Out of the previous test's delay group.
  vi.advanceTimersByTime(SKIP_DELAY_MS * 2)
})

afterAll(() => {
  vi.useRealTimers()
})

describe('hover', () => {
  it('opens a mouse hover after the open delay, not before', () => {
    const { timer, changes } = tooltip()
    timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS - 1)
    expect(changes).toStrictEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toStrictEqual([true])
  })

  it('opens nothing for a pointer that only crosses the trigger', () => {
    const { timer, changes } = tooltip()
    timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS / 2)
    timer.pointerLeave()
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2)
    expect(changes).toStrictEqual([])
  })

  it('closes after the close delay, and stays when the pointer reaches the bubble in time', () => {
    const { timer, changes } = tooltip()
    timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS)
    timer.pointerLeave()
    vi.advanceTimersByTime(CLOSE_DELAY_MS - 1)
    timer.pointerEnter('mouse') // onto the bubble
    vi.advanceTimersByTime(CLOSE_DELAY_MS * 2)
    expect(changes).toStrictEqual([true])
    timer.pointerLeave()
    vi.advanceTimersByTime(CLOSE_DELAY_MS)
    expect(changes).toStrictEqual([true, false])
  })

  it('never opens for touch: a tap performs the action', () => {
    const { timer, changes } = tooltip()
    timer.pointerEnter('touch')
    timer.press()
    timer.focus(false)
    vi.advanceTimersByTime(OPEN_DELAY_MS * 4)
    expect(changes).toStrictEqual([])
  })

  it('closes on a press and does not reopen until the pointer comes back', () => {
    const { timer, changes } = tooltip()
    timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS)
    timer.press()
    timer.focus(true)
    timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2)
    expect(changes).toStrictEqual([true, false])
  })
})

describe('the delay group', () => {
  it('opens the next tooltip at once and closes the one that was open (one at a time)', () => {
    const first = tooltip()
    const second = tooltip()
    first.timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS)
    first.timer.pointerLeave()
    second.timer.pointerEnter('mouse')
    expect(second.changes).toStrictEqual([true])
    expect(first.changes).toStrictEqual([true, false])
  })

  it('skips the delay just after a tooltip closed, and waits again once the moment has passed', () => {
    const first = tooltip()
    const second = tooltip()
    first.timer.pointerEnter('mouse')
    vi.advanceTimersByTime(OPEN_DELAY_MS)
    first.timer.dismiss()
    vi.advanceTimersByTime(SKIP_DELAY_MS - 10)
    second.timer.pointerEnter('mouse')
    expect(second.changes).toStrictEqual([true])
    second.timer.dismiss()
    vi.advanceTimersByTime(SKIP_DELAY_MS)
    second.timer.pointerLeave()
    second.timer.pointerEnter('mouse')
    expect(second.changes).toStrictEqual([true, false])
  })
})

describe('focus and dismissal', () => {
  it('opens at once on keyboard focus, not on the focus of a click, and closes on blur', () => {
    const keyboard = tooltip()
    keyboard.timer.focus(true)
    keyboard.timer.blur()
    const mouse = tooltip()
    mouse.timer.focus(false)
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2)
    expect(keyboard.changes).toStrictEqual([true, false])
    expect(mouse.changes).toStrictEqual([])
  })

  it('keeps a focused tooltip when the pointer passes over and leaves', () => {
    const { timer, changes } = tooltip()
    timer.focus(true)
    timer.pointerEnter('mouse')
    timer.pointerLeave()
    vi.advanceTimersByTime(CLOSE_DELAY_MS * 2)
    expect(changes).toStrictEqual([true])
  })
})

describe('pinning (InfoTip)', () => {
  it('pins on a click and survives the press, the pointer leaving, and closes on the next click', () => {
    const { timer, changes } = tooltip()
    timer.press()
    timer.togglePin()
    timer.pointerLeave()
    vi.advanceTimersByTime(CLOSE_DELAY_MS * 2)
    expect(changes).toStrictEqual([true])
    timer.press()
    timer.togglePin()
    expect(changes).toStrictEqual([true, false])
  })

  it('unpins on Escape or a press outside (dismiss) and on blur', () => {
    const escaped = tooltip()
    escaped.timer.togglePin()
    escaped.timer.dismiss()
    const blurred = tooltip()
    blurred.timer.togglePin()
    blurred.timer.blur()
    expect(escaped.changes).toStrictEqual([true, false])
    expect(blurred.changes).toStrictEqual([true, false])
  })
})
