/**
 * @fileoverview The bubble of a Tooltip, InfoTip or TruncatedText: the `.tooltip` recipe, `role="tooltip"`,
 * rendered in the **top layer** (`popover="manual"`) and placed by positionFloating.ts, so no ancestor's
 * overflow clips it and no z-index competes with it. It is never focusable, so it traps nothing.
 *
 * It lives in `document.body` (a portal): beside its trigger it would become a sibling that `space-x-*`,
 * `divide-*` and `last:` count. A click or press inside it goes no further than the bubble, never to the
 * row or card the trigger sits in. A browser without the Popover API shows it with `hidden` instead.
 *
 * @module components/Tooltip/TooltipBubble
 */
import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { noCleanup } from '../../hooks/noCleanup'
import { followFloating } from './positionFloating'
import type { ReactNode, SyntheticEvent } from 'react'
import type { FloatingPlacement } from './positionFloating'
import type { TooltipTimer } from './tooltipTiming'

const TOP_LAYER = 'showPopover' in HTMLElement.prototype

const stop = (event: SyntheticEvent) => event.stopPropagation()

interface TooltipBubbleProps {
  /** Set when the trigger points at the bubble (`aria-describedby`). */
  readonly id?: string
  readonly open: boolean
  readonly content: ReactNode
  /** The element the bubble is placed beside (null until it mounts). */
  readonly anchor: HTMLElement | null
  readonly placement: FloatingPlacement
  /** The bubble repeats the trigger's accessible name: hidden from assistive technology, so it is not heard twice. */
  readonly decorative: boolean
  readonly timer: TooltipTimer
}

export function TooltipBubble({ id, open, content, anchor, placement, decorative, timer }: TooltipBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    if (!open || bubble === null || anchor === null) return noCleanup
    if (TOP_LAYER) bubble.showPopover()
    const unfollow = followFloating(anchor, bubble, placement)
    return () => {
      unfollow()
      if (TOP_LAYER && bubble.matches(':popover-open')) bubble.hidePopover()
    }
  }, [open, placement, anchor])
  return createPortal(
    <div ref={bubbleRef} id={id} role="tooltip" popover={TOP_LAYER ? 'manual' : undefined} className="tooltip"
      aria-hidden={decorative ? true : undefined} hidden={!TOP_LAYER && !open}
      onPointerEnter={(event) => timer.pointerEnter(event.pointerType)} onPointerLeave={() => timer.pointerLeave()}
      onPointerDown={stop} onMouseDown={stop} onClick={stop}>
      {content}
    </div>,
    document.body,
  )
}
