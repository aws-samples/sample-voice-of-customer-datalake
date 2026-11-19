/**
 * @fileoverview A `position: fixed` menu rendered in a portal: where it opens and where Tab leaves it for. Shared by
 * the assistant's "More actions" menu (under its button) and the documents list's card menu (at the pointer, under
 * the card or under its "⋯" button).
 *
 * @module utils/fixedMenu
 */

/** Keep the menu this far from the viewport edges. */
const EDGE = 8
/** Between the anchor and the menu. */
const GAP = 4

/** What a menu opens against, in viewport coordinates: an element's box, or a point (a box of no size). */
export interface MenuAnchor {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/**
 * Place the fixed `menu` under `anchor`, flipped above it when there is no room below, and kept inside the
 * viewport: its left edge at the anchor's left (`start`), or its right edge at the anchor's right (`end`). An ancestor
 * with a transform or backdrop filter becomes the containing block of a fixed element, so where (0, 0) lands is
 * measured and corrected rather than assumed. The menu is measured without its own transform: `.menu` scales in
 * from 92 %, and a box measured mid-animation put a tall menu (the forms builder's type picker) 25 px off.
 */
export function placeFixedMenu(menu: HTMLElement, anchor: MenuAnchor, align: 'start' | 'end'): void {
  menu.style.top = '0px'
  menu.style.left = '0px'
  // (an important declaration outranks the running animation for this one synchronous measurement)
  menu.style.setProperty('transform', 'none', 'important')
  const origin = menu.getBoundingClientRect()
  menu.style.removeProperty('transform')
  const below = anchor.bottom + GAP
  const fitsBelow = below + origin.height <= window.innerHeight - EDGE
  const top = fitsBelow ? below : Math.max(EDGE, anchor.top - GAP - origin.height)
  const wanted = align === 'end' ? anchor.right - origin.width : anchor.left
  const left = Math.min(Math.max(EDGE, wanted), window.innerWidth - EDGE - origin.width)
  menu.style.top = `${top - origin.top}px`
  menu.style.left = `${left - origin.left}px`
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Tab / Shift+Tab out of a portaled menu: the next (previous) tabbable control after `trigger` in document order, as
 * if the menu were still beside it. The trigger itself when there is none.
 */
export function tabTargetFrom(trigger: HTMLElement, backwards: boolean): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.closest('[role="menu"]') === null)
  const index = all.indexOf(trigger)
  return (backwards ? all[index - 1] : all[index + 1]) ?? trigger
}
