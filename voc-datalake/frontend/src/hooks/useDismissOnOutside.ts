/**
 * @fileoverview Closes a popover (a "⋯" menu, a header panel) on a mousedown
 * outside it and on Escape — the Escape returns focus to the trigger and stops
 * there, so only the top-most layer closes.
 *
 * @module hooks/useDismissOnOutside
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { noCleanup } from './noCleanup'

export interface DisclosurePopover {
  readonly open: boolean
  readonly toggle: () => void
  readonly close: () => void
  /** Id for the popover element; pass to the trigger's `aria-controls` while open. */
  readonly panelId: string
  readonly wrapper: RefObject<HTMLDivElement | null>
  readonly trigger: RefObject<HTMLButtonElement | null>
}

/**
 * Open/close state + refs for a trigger-and-popover pair, dismissed by {@link useDismissOnOutside}.
 * `portal`: a popover rendered outside `wrapper` (a portal); a mousedown in it is not "outside".
 */
export function useDisclosurePopover(portal?: RefObject<HTMLElement | null>): DisclosurePopover {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const toggle = useCallback(() => setOpen((v) => !v), [])
  useDismissOnOutside(open, close, { container: wrapper, trigger, portal })
  return { open, toggle, close, panelId, wrapper, trigger }
}

function useDismissOnOutside(
  open: boolean,
  close: () => void,
  { container, trigger, portal }: Readonly<{
    container: RefObject<HTMLElement | null>
    trigger: RefObject<HTMLButtonElement | null>
    portal: RefObject<HTMLElement | null> | undefined
  }>,
): void {
  useEffect(() => {
    if (!open) return noCleanup
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      const isInside = (ref: RefObject<HTMLElement | null> | undefined) => ref?.current?.contains(target) === true
      if (!isInside(container) && !isInside(portal)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close, container, trigger, portal])
}
