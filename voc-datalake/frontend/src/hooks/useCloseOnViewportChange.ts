/**
 * @fileoverview A fixed menu placed against its anchor closes when the page scrolls or the window resizes: the
 * anchor moved, and a menu left where it was would point at nothing (the assistant's "More actions" menu, the
 * documents list's card menu).
 *
 * @module hooks/useCloseOnViewportChange
 */
import { useEffect } from 'react'
import { noCleanup } from './noCleanup'
import type { RefObject } from 'react'

export function useCloseOnViewportChange(open: boolean, close: () => void, menu: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return noCleanup
    const onScroll = (event: Event) => {
      // Scrolling inside the menu itself (a long menu) keeps it open.
      if (event.target instanceof Node && menu.current?.contains(event.target) === true) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close, menu])
}
