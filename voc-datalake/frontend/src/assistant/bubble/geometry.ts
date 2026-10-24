/**
 * @fileoverview Pure geometry for the draggable assistant launcher (E2E F5).
 *
 * The launcher's position is stored as offsets from the viewport's RIGHT and
 * BOTTOM edges (the corner it lives in by default), so a window resize keeps it
 * in the same corner instead of flinging it across the screen. Every rendered
 * position goes through `clampToViewport` (never off screen, on drag and on
 * resize) and `liftAboveActionBars` (never over a registered sticky action bar,
 * the page's primary actions — "hovers over the Save button").
 *
 * No DOM access here: the component measures, these functions decide.
 *
 * @module assistant/bubble/geometry
 */

/** Launcher diameter (`h-12 w-12`). */
export const LAUNCHER_SIZE = 48
/** Default distance from the right and bottom edges (`bottom-4 right-4`). */
const DEFAULT_OFFSET = 16
/** The closest the launcher may get to any viewport edge. */
export const EDGE_MARGIN = 8
/** Clearance kept between the launcher and an action bar below it. */
export const ACTION_BAR_GAP = 8
/** One arrow-key step, and the Shift+arrow step. */
export const KEY_STEP = 16
export const KEY_STEP_LARGE = 64
/** Gap between the launcher and the floating panel it opens. */
const PANEL_GAP = 16

export interface BubblePosition {
  /** Px from the viewport's right edge to the launcher's right edge. */
  readonly right: number
  /** Px from the viewport's bottom edge to the launcher's bottom edge. */
  readonly bottom: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
}

import type { CSSProperties } from 'react'
import type { BarRect } from '../../components/StickyActionBar/actionBarRegistry'

export const DEFAULT_POSITION: BubblePosition = { right: DEFAULT_OFFSET, bottom: DEFAULT_OFFSET }

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))

/** Keep the whole launcher inside the viewport, `EDGE_MARGIN` from every edge. */
export function clampToViewport(position: BubblePosition, viewport: Viewport): BubblePosition {
  const maxOffsetX = viewport.width - LAUNCHER_SIZE - EDGE_MARGIN
  const maxOffsetY = viewport.height - LAUNCHER_SIZE - EDGE_MARGIN
  return {
    right: Math.round(clamp(position.right, EDGE_MARGIN, maxOffsetX)),
    bottom: Math.round(clamp(position.bottom, EDGE_MARGIN, maxOffsetY)),
  }
}

/** Move by a pointer/keyboard delta in screen coordinates (+x right, +y down). */
export function moveBy(position: BubblePosition, dx: number, dy: number): BubblePosition {
  return { right: position.right - dx, bottom: position.bottom - dy }
}

/** The launcher's left/right span on screen for a position. */
function horizontalSpan(position: BubblePosition, viewport: Viewport): { left: number; right: number } {
  const right = viewport.width - position.right
  return { left: right - LAUNCHER_SIZE, right }
}

/**
 * Lift the launcher above every visible action bar it would otherwise COVER.
 *
 * Bars are taken from the lowest up: a bar the launcher's box touches (beside
 * it horizontally AND overlapping it vertically) pushes it up to just above
 * that bar, and the lifted box is then checked against the bars above. A bar
 * higher up the screen that the launcher does not touch leaves it alone — a
 * page with a second form further up (Account: password and objectives) no
 * longer flings the launcher to mid-screen. A bar that is off screen, or beside
 * the launcher, does not move it. The result is clamped again: on a short
 * viewport the top edge wins.
 */
export function liftAboveActionBars(position: BubblePosition, bars: readonly BarRect[], viewport: Viewport): BubblePosition {
  const span = horizontalSpan(position, viewport)
  const lowestFirst = [...bars].sort((a, b) => b.bottom - a.bottom)
  const bottom = lowestFirst.reduce(
    (current, bar) => (coversBar(current, bar, span, viewport) ? Math.max(current, viewport.height - bar.top + ACTION_BAR_GAP) : current),
    position.bottom,
  )
  return clampToViewport({ right: position.right, bottom }, viewport)
}

/** A launcher at `bottom` (within `span`) would sit on, or within the gap of, a visible `bar`. */
function coversBar(bottom: number, bar: BarRect, span: { left: number; right: number }, viewport: Viewport): boolean {
  const visible = bar.bottom > 0 && bar.top < viewport.height && bar.bottom > bar.top
  const besideIt = bar.right <= span.left || bar.left >= span.right
  const launcherBottom = viewport.height - bottom
  const launcherTop = launcherBottom - LAUNCHER_SIZE
  return visible && !besideIt && bar.top < launcherBottom + ACTION_BAR_GAP && bar.bottom > launcherTop
}

/** CSS custom properties that place the floating panel next to the launcher (from `sm` up). */
export interface PanelAnchor extends CSSProperties {
  readonly '--ap-left': string
  readonly '--ap-right': string
  readonly '--ap-top': string
  readonly '--ap-bottom': string
  readonly '--ap-max-h': string
  readonly '--ap-max-w': string
}

/**
 * Open the panel toward the larger free side of the screen: above the launcher
 * when it sits in the lower half, below it otherwise; aligned to the launcher's
 * right edge when it sits in the right half, its left edge otherwise. The max
 * sizes keep the panel inside the viewport whatever the launcher's position.
 */
export function panelAnchor(position: BubblePosition, viewport: Viewport): PanelAnchor {
  const launcherTop = viewport.height - position.bottom - LAUNCHER_SIZE
  const launcherLeft = viewport.width - position.right - LAUNCHER_SIZE
  const inLowerHalf = launcherTop + LAUNCHER_SIZE / 2 >= viewport.height / 2
  const inRightHalf = launcherLeft + LAUNCHER_SIZE / 2 >= viewport.width / 2
  const px = (n: number) => `${Math.max(0, Math.round(n))}px`
  const verticalOffset = inLowerHalf ? position.bottom + LAUNCHER_SIZE + PANEL_GAP : launcherTop + LAUNCHER_SIZE + PANEL_GAP
  const horizontalOffset = inRightHalf ? position.right : launcherLeft
  return {
    '--ap-left': inRightHalf ? 'auto' : px(horizontalOffset),
    '--ap-right': inRightHalf ? px(horizontalOffset) : 'auto',
    '--ap-top': inLowerHalf ? 'auto' : px(verticalOffset),
    '--ap-bottom': inLowerHalf ? px(verticalOffset) : 'auto',
    '--ap-max-h': px(viewport.height - verticalOffset - EDGE_MARGIN),
    '--ap-max-w': px(viewport.width - horizontalOffset - EDGE_MARGIN),
  }
}

/** Offset for an arrow key (Shift = a larger step), or null for any other key. */
const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
}

export function arrowDelta(key: string, large: boolean): { dx: number; dy: number } | null {
  const direction = Object.hasOwn(ARROW_DIRECTIONS, key) ? ARROW_DIRECTIONS[key] : undefined
  if (direction === undefined) return null
  const step = large ? KEY_STEP_LARGE : KEY_STEP
  return { dx: direction[0] * step, dy: direction[1] * step }
}
