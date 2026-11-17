/**
 * @fileoverview Places a floating bubble (a Tooltip, an InfoTip) beside its trigger with `@floating-ui/dom`:
 * on the side asked for, **flipped** to the opposite side when there is no room, and **shifted** along it
 * so it stays {@link VIEWPORT_MARGIN_PX} inside the viewport.
 *
 * The bubble is in the top layer (`popover="manual"`), so it is placed in viewport coordinates
 * (`strategy: 'fixed'`): no ancestor's overflow clips it and no z-index competes with it.
 *
 * @module components/Tooltip/positionFloating
 */
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type { Placement } from '@floating-ui/dom'

/** Where a bubble goes. `start` and `end` follow the reading direction (left and right in LTR). */
export type FloatingPlacement = 'top' | 'bottom' | 'start' | 'end'

/** Space between the trigger and the bubble. */
export const FLOATING_GAP_PX = 6
/** The least space between the bubble and the viewport's edge. */
export const VIEWPORT_MARGIN_PX = 8

/** The physical side of `placement` in the trigger's reading direction. */
export function physicalSide(placement: FloatingPlacement, rtl: boolean): Placement {
  if (placement === 'start') return rtl ? 'right' : 'left'
  if (placement === 'end') return rtl ? 'left' : 'right'
  return placement
}

/**
 * Moves `floating` next to `reference` (its `left` / `top`, in viewport pixels) and records the side it
 * ended on in `data-placement`. Resolves to that side.
 */
export async function positionFloating(
  reference: Element,
  floating: HTMLElement,
  placement: FloatingPlacement,
): Promise<Placement> {
  const rtl = getComputedStyle(reference).direction === 'rtl'
  const { x, y, placement: side } = await computePosition(reference, floating, {
    strategy: 'fixed',
    placement: physicalSide(placement, rtl),
    middleware: [
      offset(FLOATING_GAP_PX),
      flip({ padding: VIEWPORT_MARGIN_PX }),
      shift({ padding: VIEWPORT_MARGIN_PX }),
    ],
  })
  floating.style.left = `${x}px`
  floating.style.top = `${y}px`
  floating.dataset.placement = side
  return side
}

/** A failed placement leaves the bubble where it was: it is still readable, so nothing else is undone. */
function reportPlacementError(error: unknown): void {
  console.warn('Tooltip: could not place the bubble', error)
}

/**
 * Keeps `floating` beside `reference` while either moves (scroll, resize, layout shift) and places it now.
 * Returns the function that stops following.
 */
export function followFloating(reference: Element, floating: HTMLElement, placement: FloatingPlacement): () => void {
  return autoUpdate(reference, floating, () => {
    positionFloating(reference, floating, placement).catch(reportPlacementError)
  })
}
