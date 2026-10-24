/**
 * @fileoverview Drag, keyboard-move and persist the assistant launcher (E2E F5).
 *
 * - Pointer: press and move more than `DRAG_THRESHOLD` px to drag; the click
 *   that ends a drag does not toggle the panel. `touch-action: none` on the
 *   launcher lets touch drags through.
 * - Keyboard: arrow keys move the focused launcher (Shift = larger steps),
 *   Home puts it back in the default corner.
 * - Every rendered position is clamped to the viewport (re-clamped on resize,
 *   without overwriting the stored spot, so growing the window back restores
 *   it) and, when not being dragged, lifted above registered action bars.
 *
 * @module assistant/bubble/useLauncherPosition
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import { useActionBarRects } from '../../components/StickyActionBar/actionBarRegistry'
import { useBubbleStore, useBubbleUserKey } from './bubbleStore'
import {
  DEFAULT_POSITION, arrowDelta, clampToViewport, liftAboveActionBars, moveBy, panelAnchor,
} from './geometry'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import type { BubblePosition, PanelAnchor, Viewport } from './geometry'

/** Movement (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

// A string snapshot keeps useSyncExternalStore's identity check cheap and stable.
const viewportSnapshot = (): string => `${window.innerWidth}x${window.innerHeight}`

function useViewport(): Viewport {
  const snapshot = useSyncExternalStore(subscribeResize, viewportSnapshot, viewportSnapshot)
  const [width = 0, height = 0] = snapshot.split('x').map(Number)
  return { width, height }
}

interface DragStart {
  readonly pointerId: number
  readonly x: number
  readonly y: number
  readonly origin: BubblePosition
  moved: boolean
}

export interface LauncherPosition {
  /** Where the launcher renders (clamped, lifted above action bars). */
  readonly position: BubblePosition
  /** CSS variables that place the floating panel beside the launcher. */
  readonly panelAnchor: PanelAnchor
  /** The user has moved the launcher away from the default corner. */
  readonly moved: boolean
  readonly dragging: boolean
  readonly reset: () => void
  readonly handlers: {
    readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void
    readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void
    readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void
    readonly onPointerCancel: () => void
    readonly onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
    /** Run before the launcher's own click: true = swallow it (it ended a drag). */
    readonly consumeClick: (e: MouseEvent<HTMLElement>) => boolean
  }
}

export function useLauncherPosition(): LauncherPosition {
  const user = useBubbleUserKey()
  const stored = useBubbleStore((s) => s.positions[user])
  const setPosition = useBubbleStore((s) => s.setPosition)
  const resetPosition = useBubbleStore((s) => s.resetPosition)
  const viewport = useViewport()
  const bars = useActionBarRects()
  const [dragPosition, setDragPosition] = useState<BubblePosition | null>(null)
  const dragStart = useRef<DragStart | null>(null)
  const swallowClick = useRef(false)

  const resting = liftAboveActionBars(clampToViewport(stored ?? DEFAULT_POSITION, viewport), bars, viewport)
  const position = dragPosition ?? resting
  const save = (next: BubblePosition) => setPosition(user, clampToViewport(next, viewport))
  const reset = () => resetPosition(user)

  const endDrag = () => {
    dragStart.current = null
    setDragPosition(null)
  }

  return {
    position,
    panelAnchor: panelAnchor(position, viewport),
    moved: stored !== undefined,
    dragging: dragPosition !== null,
    reset,
    handlers: {
      onPointerDown: (e) => {
        if (e.button !== 0) return
        dragStart.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, origin: position, moved: false }
        // Capture at once: the first move of a fast drag already leaves the 48px
        // button, and without capture it never reaches it (absent in jsdom).
        if ('setPointerCapture' in e.currentTarget) e.currentTarget.setPointerCapture(e.pointerId)
      },
      onPointerMove: (e) => {
        const start = dragStart.current
        if (start?.pointerId !== e.pointerId) return
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        start.moved = true
        setDragPosition(clampToViewport(moveBy(start.origin, dx, dy), viewport))
      },
      onPointerUp: (e) => {
        const start = dragStart.current
        if (start?.pointerId !== e.pointerId) return
        if (start.moved) {
          swallowClick.current = true
          save(moveBy(start.origin, e.clientX - start.x, e.clientY - start.y))
        }
        endDrag()
      },
      onPointerCancel: endDrag,
      onKeyDown: (e) => {
        if (e.key === 'Home') {
          e.preventDefault()
          reset()
          return
        }
        const delta = arrowDelta(e.key, e.shiftKey)
        if (delta === null) return
        e.preventDefault()
        save(moveBy(position, delta.dx, delta.dy))
      },
      consumeClick: (e) => {
        if (!swallowClick.current) return false
        swallowClick.current = false
        e.preventDefault()
        return true
      },
    },
  }
}
