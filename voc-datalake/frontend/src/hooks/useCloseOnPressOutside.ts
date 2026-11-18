/**
 * @fileoverview While a popover is open, a press (mousedown) anywhere but the popover and its opener closes it: the
 * opener's own click toggles it, so a press on it is not "outside" (null: opened some other way, every press outside
 * the popover closes it). Focus stays where the press put it. The press is read along its composed path.
 *
 * @module hooks/useCloseOnPressOutside
 */
import { useEffect } from 'react'
import { noCleanup } from './noCleanup'
import type { RefObject } from 'react'

export function useCloseOnPressOutside(open: boolean, close: () => void, popover: RefObject<HTMLElement | null>,
  opener: RefObject<HTMLElement | null> | null): void {
  useEffect(() => {
    if (!open) return noCleanup
    const controller = new AbortController()
    document.addEventListener('mousedown', (event) => {
      const path = event.composedPath()
      const kept = [popover.current, opener?.current ?? null].some((element) => element !== null && path.includes(element))
      if (!kept) close()
    }, { signal: controller.signal })
    return () => controller.abort()
  }, [open, close, popover, opener])
}
