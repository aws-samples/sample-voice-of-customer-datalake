/**
 * @fileoverview Focus management for NON-modal overlays (menus, listboxes,
 * popovers, drawers) — the part of ModalShell's contract a popup still owes a
 * keyboard user without trapping focus:
 *
 * - on open, focus moves into the overlay (`initialFocus` selector, else its
 *   first focusable), so the user lands where the choices are;
 * - Escape closes it (handled on the container, propagation stopped so an
 *   enclosing fullscreen panel or dialog does not also close);
 * - `closeOnFocusOut`: Tab moving focus out of it closes it (APG menu/listbox
 *   behaviour), instead of leaving an orphaned popup open over the page;
 * - on close, focus returns to the element that had it before the overlay
 *   opened (the trigger) — unless the user already moved it somewhere else on
 *   purpose (clicked another control, or tabbed out).
 *
 * Modal dialogs use ModalShell instead; this hook never traps Tab.
 *
 * @module hooks/useOverlayFocus
 */
import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ')

interface OverlayFocusOptions {
  /** Called on Escape inside the overlay, and on focus leaving it when `closeOnFocusOut`. */
  readonly onClose: () => void
  /** Selector (within the overlay) of the element to focus on open; default: first focusable. */
  readonly initialFocus?: string
  /** Close when focus moves outside the overlay (menus, listboxes). Default false. */
  readonly closeOnFocusOut?: boolean
  /**
   * Element to send focus back to on close. Default: whatever had focus when
   * the overlay opened (normally its trigger).
   */
  readonly returnFocusTo?: RefObject<HTMLElement | null>
}

function firstFocusable(container: HTMLElement, selector: string | undefined): HTMLElement | null {
  const preferred = selector === undefined ? null : container.querySelector<HTMLElement>(selector)
  return preferred ?? container.querySelector<HTMLElement>(FOCUSABLE)
}

/**
 * Focuses the overlay's first target, retrying for a few frames: an overlay
 * that becomes visible through a `visibility` transition (the mobile drawer) is
 * still `hidden` for the first frame(s) after it opens, and focus() on it
 * silently does nothing.
 */
const FOCUS_RETRY_FRAMES = 12

function focusInto(container: HTMLElement, selector: string | undefined, framesLeft = FOCUS_RETRY_FRAMES): void {
  if (!container.isConnected || container.contains(document.activeElement)) return
  const target = firstFocusable(container, selector)
  target?.focus()
  if (target !== null && document.activeElement !== target && framesLeft > 0) {
    requestAnimationFrame(() => focusInto(container, selector, framesLeft - 1))
  }
}

/**
 * Wires focus-in / Escape / focus-out / focus-return for the overlay at `ref`
 * while `open` is true. Mount it in the component that owns the open state.
 */
export function useOverlayFocus(ref: RefObject<HTMLElement | null>, open: boolean, options: OverlayFocusOptions): void {
  // Latest options without re-running the effect (and re-focusing) on every render.
  const latest = useRef(options)
  useEffect(() => { latest.current = options })

  useEffect(() => {
    const container = ref.current
    if (!open || container === null) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const state = { leftByFocus: false }

    if (!container.contains(document.activeElement)) focusInto(container, latest.current.initialFocus)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      latest.current.onClose()
    }
    const onFocusOut = (event: FocusEvent) => {
      if (latest.current.closeOnFocusOut !== true) return
      const next = event.relatedTarget
      // relatedTarget null = focus went to the page/body or another window; leave
      // the overlay alone then (a click inside it can blur briefly in some browsers).
      if (next instanceof Node && !container.contains(next)) {
        state.leftByFocus = true
        latest.current.onClose()
      }
    }
    container.addEventListener('keydown', onKeyDown)
    container.addEventListener('focusout', onFocusOut)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('focusout', onFocusOut)
      if (state.leftByFocus) return
      // Return focus only if it is still inside the (closing) overlay or was lost to <body>;
      // a user who clicked elsewhere keeps the focus they chose.
      const active = document.activeElement
      const lost = active === null || active === document.body || container.contains(active)
      const target = latest.current.returnFocusTo?.current ?? opener
      if (lost && target?.isConnected === true) target.focus()
    }
  }, [ref, open])
}
