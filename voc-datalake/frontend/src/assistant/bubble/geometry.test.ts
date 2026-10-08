import { describe, expect, it } from 'vitest'
import {
  ACTION_BAR_GAP, DEFAULT_POSITION, EDGE_MARGIN, KEY_STEP, KEY_STEP_LARGE, LAUNCHER_SIZE,
  arrowDelta, clampToViewport, liftAboveActionBars, moveBy, panelAnchor,
} from './geometry'

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

describe('clampToViewport', () => {
  it.each([DESKTOP, PHONE])('keeps the launcher inside a %o viewport on every edge', (viewport) => {
    const maxX = viewport.width - LAUNCHER_SIZE - EDGE_MARGIN
    const maxY = viewport.height - LAUNCHER_SIZE - EDGE_MARGIN
    expect(clampToViewport({ right: -500, bottom: -500 }, viewport)).toStrictEqual({ right: EDGE_MARGIN, bottom: EDGE_MARGIN })
    expect(clampToViewport({ right: 99_999, bottom: 99_999 }, viewport)).toStrictEqual({ right: maxX, bottom: maxY })
    expect(clampToViewport({ right: 100, bottom: 200 }, viewport)).toStrictEqual({ right: 100, bottom: 200 })
  })

  it('pulls a desktop position back on screen after the window shrinks to a phone', () => {
    expect(clampToViewport({ right: 1200, bottom: 800 }, PHONE)).toStrictEqual({
      right: PHONE.width - LAUNCHER_SIZE - EDGE_MARGIN,
      bottom: PHONE.height - LAUNCHER_SIZE - EDGE_MARGIN,
    })
  })

  it('never inverts on a viewport smaller than the launcher', () => {
    expect(clampToViewport({ right: 30, bottom: 30 }, { width: 40, height: 40 })).toStrictEqual({ right: EDGE_MARGIN, bottom: EDGE_MARGIN })
  })
})

describe('moveBy', () => {
  it('moves in screen coordinates (+x right, +y down) on right/bottom offsets', () => {
    expect(moveBy({ right: 100, bottom: 100 }, 10, 20)).toStrictEqual({ right: 90, bottom: 80 })
    expect(moveBy({ right: 100, bottom: 100 }, -10, -20)).toStrictEqual({ right: 110, bottom: 120 })
  })
})

describe('liftAboveActionBars', () => {
  // A full-width sticky Save bar 56px tall at the bottom of a 1440×900 viewport.
  const bar = { top: 844, bottom: 900, left: 240, right: 1416 }

  it('lifts the default launcher above a bar under it', () => {
    const lifted = liftAboveActionBars(DEFAULT_POSITION, [bar], DESKTOP)
    expect(lifted.bottom).toBe(DESKTOP.height - bar.top + ACTION_BAR_GAP)
    // Launcher bottom edge on screen sits above the bar's top edge.
    expect(DESKTOP.height - lifted.bottom).toBeLessThan(bar.top)
  })

  it('leaves a launcher that is already above the bar where it is', () => {
    expect(liftAboveActionBars({ right: 16, bottom: 300 }, [bar], DESKTOP)).toStrictEqual({ right: 16, bottom: 300 })
  })

  it('ignores a bar beside the launcher, off screen, or empty', () => {
    const beside = { top: 844, bottom: 900, left: 0, right: 200 }
    const below = { top: 950, bottom: 1000, left: 0, right: 1440 }
    const empty = { top: 844, bottom: 844, left: 0, right: 1440 }
    expect(liftAboveActionBars(DEFAULT_POSITION, [beside, below, empty], DESKTOP)).toStrictEqual(DEFAULT_POSITION)
  })

  it('clears the tallest of several overlapping bars', () => {
    const tall = { ...bar, top: 780 }
    expect(liftAboveActionBars(DEFAULT_POSITION, [bar, tall], DESKTOP).bottom).toBe(DESKTOP.height - 780 + ACTION_BAR_GAP)
  })

  it('stays put beside a bar higher up the screen that it does not touch (a second form further up)', () => {
    const higher = { top: 300, bottom: 356, left: 240, right: 1416 }
    expect(liftAboveActionBars(DEFAULT_POSITION, [higher], DESKTOP)).toStrictEqual(DEFAULT_POSITION)
  })

  it('lifts above the bottom bar only, not a second bar further up the page', () => {
    const higher = { top: 300, bottom: 356, left: 240, right: 1416 }
    expect(liftAboveActionBars(DEFAULT_POSITION, [higher, bar], DESKTOP).bottom).toBe(DESKTOP.height - bar.top + ACTION_BAR_GAP)
  })

  it('keeps climbing when the lift lands on the next bar up', () => {
    // Two stacked bars with a gap smaller than the launcher: clearing the low one lands on the high one.
    const high = { top: 790, bottom: 836, left: 240, right: 1416 }
    expect(liftAboveActionBars(DEFAULT_POSITION, [high, bar], DESKTOP).bottom).toBe(DESKTOP.height - high.top + ACTION_BAR_GAP)
  })
})

describe('panelAnchor', () => {
  it('opens up and to the left of a launcher in the bottom-right corner', () => {
    expect(panelAnchor(DEFAULT_POSITION, DESKTOP)).toStrictEqual({
      '--ap-right': '16px',
      '--ap-left': 'auto',
      '--ap-bottom': `${16 + LAUNCHER_SIZE + 16}px`,
      '--ap-top': 'auto',
      '--ap-max-h': `${DESKTOP.height - (16 + LAUNCHER_SIZE + 16) - EDGE_MARGIN}px`,
      '--ap-max-w': `${DESKTOP.width - 16 - EDGE_MARGIN}px`,
    })
  })

  it('opens down and to the right of a launcher in the top-left corner', () => {
    const topLeft = { right: DESKTOP.width - LAUNCHER_SIZE - 20, bottom: DESKTOP.height - LAUNCHER_SIZE - 30 }
    expect(panelAnchor(topLeft, DESKTOP)).toMatchObject({
      '--ap-left': '20px',
      '--ap-right': 'auto',
      '--ap-top': `${30 + LAUNCHER_SIZE + 16}px`,
      '--ap-bottom': 'auto',
      '--ap-max-w': `${DESKTOP.width - 20 - EDGE_MARGIN}px`,
    })
  })
})

describe('arrowDelta', () => {
  it('maps the four arrows to a step, Shift to a larger one', () => {
    expect(arrowDelta('ArrowLeft', false)).toStrictEqual({ dx: -KEY_STEP, dy: 0 })
    expect(arrowDelta('ArrowRight', false)).toStrictEqual({ dx: KEY_STEP, dy: 0 })
    expect(arrowDelta('ArrowUp', true)).toStrictEqual({ dx: 0, dy: -KEY_STEP_LARGE })
    expect(arrowDelta('ArrowDown', true)).toStrictEqual({ dx: 0, dy: KEY_STEP_LARGE })
  })

  it('ignores every other key, including inherited object keys', () => {
    expect(arrowDelta('Enter', false)).toBeNull()
    expect(arrowDelta('toString', false)).toBeNull()
  })
})
