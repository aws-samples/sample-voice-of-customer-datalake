/**
 * @fileoverview The behaviour of a strip of tabs that scrolls sideways (docs/kiro-design-system.md, `.tab-strip`):
 * which side is cut (the strip fades it through `data-cut-start` / `data-cut-end`), a scroll button's step, and
 * bringing a tab into view clear of the fade. Its scroll buttons are `StripScrollButton`.
 *
 * Used by the form builder's tabs (pages/FeedbackForms/builder/BuilderTabs, 7.04.00, through IconTabs
 * `scrollLabels`), whose eight tabs do not fit a phone.
 *
 * @module components/TabStrip/tabStrip
 */
import { useCallback, useEffect, useState } from 'react'
import { noCleanup } from '../../hooks/noCleanup'

/** How far one press of a scroll button moves the strip, as a share of what it shows. */
const SCROLL_SHARE = 0.7
/** How far from the strip's edges a tab brought into view stops: clear of the fade (`.tab-strip`). */
const REVEAL_PAD = 28

/** Which ends of the strip are cut (there is more to see that way). */
export interface StripCut { readonly start: boolean; readonly end: boolean }

/** Whether the strip is cut at its start or its end, read again as it scrolls and as it or its tabs change size. */
export function useStripCut(strip: HTMLDivElement | null): StripCut {
  const [cut, setCut] = useState<StripCut>({ start: false, end: false })
  const measure = useCallback(() => {
    if (strip === null) return
    const start = strip.scrollLeft > 1
    const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
    setCut((before) => (before.start === start && before.end === end ? before : { start, end }))
  }, [strip])
  useEffect(() => {
    if (strip === null) return noCleanup
    // (a ResizeObserver reports each element once as it starts observing it: the first measure)
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    if (strip.firstElementChild !== null) observer.observe(strip.firstElementChild)
    strip.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', measure)
    }
  }, [strip, measure])
  return cut
}

/** Scrolls the strip just enough to show `tab` whole, clear of the fade (no layout read in jsdom: nothing moves). */
export function revealInStrip(strip: HTMLElement | null, tab: HTMLElement | undefined): void {
  if (strip === null || tab === undefined) return
  const shown = strip.getBoundingClientRect()
  const box = tab.getBoundingClientRect()
  if (box.left < shown.left + REVEAL_PAD) strip.scrollLeft -= shown.left + REVEAL_PAD - box.left
  else if (box.right > shown.right - REVEAL_PAD) strip.scrollLeft += box.right - (shown.right - REVEAL_PAD)
}

/** One press of a scroll button: most of what the strip shows, toward `direction`. */
export function scrollStrip(strip: HTMLElement | null, direction: 1 | -1): void {
  if (strip !== null) strip.scrollBy({ left: direction * strip.clientWidth * SCROLL_SHARE, behavior: 'smooth' })
}
