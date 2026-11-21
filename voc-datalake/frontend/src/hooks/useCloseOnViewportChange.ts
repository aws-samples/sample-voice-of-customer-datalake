/**
 * @fileoverview A fixed menu placed against its anchor closes when the page scrolls or the window resizes: the
 * anchor moved, and a menu left where it was would point at nothing (the assistant's "More actions" menu, the
 * documents list's card menu).
 *
 * Given its `anchor` (the trigger), a scroll closes the menu only when it moved the anchor. A browser dispatches a
 * scroll's event at the next frame: a press that first brings its trigger into view (a screen reader's activate,
 * Voice Control, Playwright's click) opened the menu, then that scroll's event came and closed it (the forms builder's
 * type picker under a long list of questions). A scroll elsewhere (another pane, the assistant's log) keeps it open too.
 *
 * @module hooks/useCloseOnViewportChange
 */
import { useEffect } from 'react'
import { noCleanup } from './noCleanup'
import type { RefObject } from 'react'

/** Less than this, in px, is layout rounding, not a move. */
const MOVED_PX = 1

const anchorMoved = (before: DOMRect, after: DOMRect): boolean =>
  Math.abs(after.top - before.top) >= MOVED_PX || Math.abs(after.left - before.left) >= MOVED_PX

export function useCloseOnViewportChange(open: boolean, close: () => void, menu: RefObject<HTMLElement | null>,
  anchor?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return noCleanup
    // Where the anchor is as the menu opens: the menu was just placed against it.
    const placedAt = anchor?.current?.getBoundingClientRect()
    const onScroll = (event: Event) => {
      // Scrolling inside the menu itself (a long menu) keeps it open.
      if (event.target instanceof Node && menu.current?.contains(event.target) === true) return
      const now = anchor?.current?.getBoundingClientRect()
      if (placedAt !== undefined && now !== undefined && !anchorMoved(placedAt, now)) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close, menu, anchor])
}
