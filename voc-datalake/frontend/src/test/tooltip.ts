/**
 * @fileoverview Reads the app's Tooltip (components/Tooltip) in a spec: rests a mouse on a trigger and resolves to
 * the bubble it opens. Real timers: the bubble opens 80 ms after the pointer arrives (tooltipTiming.ts).
 */
import { fireEvent, waitFor } from '@testing-library/react'

/** The open bubble (`role="tooltip"` without `hidden`; a description's bubble stays in the page, hidden, while closed). */
function openBubble(): HTMLElement {
  const open = [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')].find((tip) => !tip.hidden)
  if (open === undefined) throw new Error('no tooltip is open')
  return open
}

/** Rests a mouse on `trigger` and resolves to the tooltip it opens (a missing trigger, `closest()`'s null, fails). */
export async function openTooltip(trigger: Element | null): Promise<HTMLElement> {
  if (trigger === null) throw new Error('no tooltip trigger')
  fireEvent.pointerOver(trigger, { pointerType: 'mouse' })
  return waitFor(openBubble)
}
