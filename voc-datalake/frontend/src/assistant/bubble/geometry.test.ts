import { describe, expect, it } from 'vitest'
import {
  ACTION_BAR_GAP, BESIDE_GAP, DEFAULT_POSITION, EDGE_MARGIN, KEY_STEP, KEY_STEP_LARGE, LAUNCHER_SIZE,
  arrowDelta, clampToViewport, keepClear, liftAboveActionBars, moveBy, panelAnchor, stepAside,
} from './geometry'
import type { BubblePosition, Viewport } from './geometry'
import type { BarRect, KeepClearZone } from '../../components/StickyActionBar/actionBarRegistry'

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

/** The launcher's box on screen. */
function boxOf(position: BubblePosition, viewport: Viewport): BarRect {
  const right = viewport.width - position.right
  const bottom = viewport.height - position.bottom
  return { left: right - LAUNCHER_SIZE, right, top: bottom - LAUNCHER_SIZE, bottom }
}

const overlap = (a: BarRect, b: BarRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

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

describe('stepAside', () => {
  // The builder's preview pane at 1440×900 as measured before 7.55.01 (forms audit §4): 22rem at the page's end
  // edge, taller than the window; the launcher sat on its Next.
  const preview = { top: 316, bottom: 1094, left: 1064, right: 1416 }

  it('moves the default launcher to the pane\'s inline-start side, at the same height', () => {
    const aside = stepAside(DEFAULT_POSITION, [preview], DESKTOP)
    expect(aside).toStrictEqual({ right: DESKTOP.width - preview.left + BESIDE_GAP, bottom: DEFAULT_POSITION.bottom })
    expect(boxOf(aside, DESKTOP).right).toBe(preview.left - BESIDE_GAP)
  })

  it('keeps a spot the person chose wherever it covers no zone', () => {
    const leftOfPane = { right: 600, bottom: 40 }
    const abovePane = { right: 16, bottom: DESKTOP.height - 200 }
    expect(stepAside(leftOfPane, [preview], DESKTOP)).toStrictEqual(leftOfPane)
    expect(stepAside(abovePane, [preview], DESKTOP)).toStrictEqual(abovePane)
  })

  it('moves a spot the person dragged onto the pane beside it, keeping its height', () => {
    expect(stepAside({ right: 200, bottom: 300 }, [preview], DESKTOP)).toStrictEqual({ right: DESKTOP.width - preview.left + BESIDE_GAP, bottom: 300 })
  })

  it('leaves the launcher alone under a pane that ends above it', () => {
    expect(stepAside(DEFAULT_POSITION, [{ ...preview, bottom: 700 }], DESKTOP)).toStrictEqual(DEFAULT_POSITION)
  })

  it('clears a second zone it lands on, taking them from the rightmost', () => {
    const next = { top: 316, bottom: 1094, left: 900, right: 1050 }
    expect(stepAside(DEFAULT_POSITION, [next, preview], DESKTOP)).toStrictEqual({ right: DESKTOP.width - next.left + BESIDE_GAP, bottom: 16 })
  })

  it('stays put beside a zone that leaves it no room on its inline-start side (a full-width pane on a phone)', () => {
    expect(stepAside(DEFAULT_POSITION, [{ top: 200, bottom: 2000, left: 16, right: 374 }], PHONE)).toStrictEqual(DEFAULT_POSITION)
  })
})

describe('keepClear', () => {
  const beside = (rect: BarRect): KeepClearZone => ({ ...rect, mode: 'beside' })
  const lift = (rect: BarRect): KeepClearZone => ({ ...rect, mode: 'lift' })

  it('rests in the default corner with nothing registered', () => {
    expect(keepClear(DEFAULT_POSITION, [], DESKTOP)).toStrictEqual(DEFAULT_POSITION)
  })

  it('steps beside the preview, then lifts above an action bar under the spot it stepped to', () => {
    const preview = beside({ top: 316, bottom: 1094, left: 1064, right: 1416 })
    const bar = lift({ top: 844, bottom: 900, left: 260, right: 1048 })
    expect(keepClear(DEFAULT_POSITION, [preview, bar], DESKTOP)).toStrictEqual({
      right: DESKTOP.width - preview.left + BESIDE_GAP, bottom: DESKTOP.height - bar.top + ACTION_BAR_GAP,
    })
  })

  it('still lifts above a full-width action bar alone, as before', () => {
    const bar = lift({ top: 844, bottom: 900, left: 240, right: 1416 })
    expect(keepClear(DEFAULT_POSITION, [bar], DESKTOP)).toStrictEqual(liftAboveActionBars(DEFAULT_POSITION, [bar], DESKTOP))
  })

  /**
   * The pages the launcher shares a corner with (7.55.01, forms audit §4.1), at the end edge of the page scroller
   * (24 px padding, the sidebar 236 px): the builder's preview pane (22rem; 28rem from 1600 px), taller than the window
   * or fitted to it; the picker's preview (24rem); and a page with a sticky Save bar across the column beside a pane.
   */
  const LAPTOPS: readonly Viewport[] = [{ width: 1280, height: 800 }, DESKTOP, { width: 1920, height: 1080 }]
  const builderPane = (viewport: Viewport, bottom: number): KeepClearZone => {
    const end = viewport.width - 24
    return beside({ top: 316, bottom, left: end - (viewport.width >= 1600 ? 448 : 352), right: end })
  }
  function layouts(viewport: Viewport): Record<string, KeepClearZone[]> {
    const fitted = builderPane(viewport, viewport.height - 24)
    return {
      'builder preview, taller than the window': [builderPane(viewport, 1094)],
      'builder preview, fitted to the window': [fitted],
      'picker preview': [beside({ top: 243, bottom: 1599, left: viewport.width - 24 - 384, right: viewport.width - 24 })],
      'preview beside a column with a Save bar': [
        fitted,
        lift({ top: viewport.height - 56, bottom: viewport.height, left: 260, right: fitted.left - 16 }),
      ],
    }
  }

  /** The default corner, and a spot every 40 px across the viewport (where a person may have dragged it). */
  function startingSpots(viewport: Viewport): BubblePosition[] {
    const steps = (size: number) => Array.from({ length: Math.floor(size / 40) + 1 }, (_, i) => i * 40)
    return [DEFAULT_POSITION, ...steps(viewport.width).flatMap((right) => steps(viewport.height)
      .map((bottom) => clampToViewport({ right, bottom }, viewport)))]
  }

  it.each(LAPTOPS)('never leaves the launcher on a registered zone at %o', (viewport) => {
    const covering = Object.entries(layouts(viewport)).flatMap(([name, zones]) => startingSpots(viewport)
      .map((spot) => ({ name, spot, rest: keepClear(spot, zones, viewport) }))
      .filter(({ rest }) => zones.some((zone) => overlap(boxOf(rest, viewport), zone))))
    expect(covering).toStrictEqual([])
  })

  it.each(LAPTOPS)('keeps the default corner\'s height beside the builder preview at %o', (viewport) => {
    const pane = builderPane(viewport, 1094)
    expect(keepClear(DEFAULT_POSITION, [pane], viewport)).toStrictEqual({ right: viewport.width - pane.left + BESIDE_GAP, bottom: DEFAULT_POSITION.bottom })
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
