/**
 * @fileoverview Shared modal shell — owns dialog semantics so individual modals
 * cannot forget them.
 *
 * The audit for issue #283 found 23 files rendering `fixed inset-0` overlays, of
 * which only 2 declared `role="dialog"` and 3 handled Escape. Fixing each modal
 * individually (as #281 did for UserProfileModal) does not scale and leaves the
 * next author free to omit the same things again. This shell makes correct
 * behaviour the default:
 *
 * - `role="dialog"` + `aria-modal` + a non-empty accessible name
 * - Escape closes; overlay click closes, with the panel NOT swallowing its clicks
 * - focus moves into the dialog on open and returns to the trigger on close
 * - Tab is trapped inside the dialog, in both directions
 *
 * STACKING: Escape and Tab are handled in one document-level listener that bails
 * unless focus is inside *this* panel. ConfirmModal is used as an unsaved-changes
 * guard inside other modals, so shells nest; an unguarded document listener would
 * let one Escape close both dialogs, and would let shift-Tab in the inner dialog
 * yank focus into the outer panel. This is also why Escape is handled here rather
 * than via useEscapeKey — that hook is unguarded by design.
 *
 * @module components/ModalShell
 */
import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'

interface ModalShellProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /**
   * The dialog's accessible name. A plain string rather than a node, so the name
   * can never resolve to empty — an earlier draft rendered the title into a
   * hidden element and pointed aria-labelledby at it, which produced a nameless
   * dialog whenever the title was a ReactNode. The VISIBLE heading stays in
   * `children`, where each modal already renders it.
   */
  readonly ariaLabel: string
  readonly children: ReactNode
  /** Extra classes for the panel, e.g. a different max-width. */
  readonly panelClassName?: string
  /**
   * Set false for modals that must not be dismissed casually (in-flight work).
   * Escape and overlay click are disabled together — leaving one active would be
   * an inconsistency users cannot see.
   */
  readonly dismissable?: boolean
}

/**
 * Focusable descendants in DOM order, excluding anything not actually reachable.
 *
 * `display:none` must be checked up the ancestor chain: computed `display` of a
 * child inside a hidden container is the child's own value, so checking only the
 * element itself misses the motivating case — collapsible sections hide the
 * container, not each control. `visibility:hidden` inherits, so one check does.
 */
function focusable(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])',
  )
  // NB: deliberately not using offsetParent — jsdom does no layout and returns
  // null for every element, which would filter the list empty under test.
  /** The element and each ancestor up to and including `root`. */
  const selfAndAncestors = (el: HTMLElement): HTMLElement[] =>
    el === root || el.parentElement === null ? [el] : [el, ...selfAndAncestors(el.parentElement)]

  const hiddenByAncestor = (el: HTMLElement): boolean =>
    selfAndAncestors(el).some((node) => getComputedStyle(node).display === 'none')
  return [...candidates].filter((el) => {
    if (el.closest('[hidden]') !== null || el.closest('[aria-hidden="true"]') !== null) return false
    if (el.closest('details:not([open])') !== null) return false
    if (getComputedStyle(el).visibility === 'hidden') return false
    return !hiddenByAncestor(el)
  })
}

/**
 * Open shells, outermost first. Only the last one reacts to Escape and Tab.
 *
 * An earlier revision gated on `panel.contains(document.activeElement)`, which
 * silently disabled BOTH Escape and the Tab trap whenever focus left the panel —
 * and that happens in ordinary flows: the focused control is removed or becomes
 * disabled (browsers drop focus to <body>), focus enters an iframe, or something
 * calls blur(). The shell would then fail exactly as the modals it replaces do,
 * without any visible signal. Registration order is authoritative instead.
 */
const openShells: HTMLElement[] = []

export default function ModalShell({
  isOpen,
  onClose,
  ariaLabel,
  children,
  panelClassName,
  dismissable = true,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Move focus into the dialog on open, and restore it to whatever opened the
  // dialog on close — otherwise keyboard users are dropped at the top of the page.
  useEffect(() => {
    if (!isOpen) return
    const active = document.activeElement
    // Type guard rather than an assertion: activeElement is Element | null, and
    // only an HTMLElement can be re-focused.
    const trigger = active instanceof HTMLElement ? active : null
    const panel = panelRef.current
    const first = panel ? focusable(panel)[0] : null
    ;(first ?? panel)?.focus()
    return () => trigger?.focus?.()
  }, [isOpen])

  // Register in the open-shell stack for as long as this shell is open, so the
  // keydown handler can tell whether it is the top-most dialog.
  useEffect(() => {
    if (!isOpen) return
    const panel = panelRef.current
    if (!panel) return
    openShells.push(panel)
    return () => {
      const i = openShells.indexOf(panel)
      if (i !== -1) openShells.splice(i, 1)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      const panel = panelRef.current
      if (!panel) return
      // Only the top-most open dialog reacts, regardless of where focus is.
      if (openShells[openShells.length - 1] !== panel) return

      if (e.key === 'Escape') {
        if (dismissable) onClose()
        return
      }
      if (e.key !== 'Tab') return

      const items = focusable(panel)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, dismissable, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay is a sibling of the panel, not its container, so clicks inside
          the panel are never mistaken for overlay clicks. */}
      <div
        data-testid="modal-overlay"
        aria-hidden="true"
        className="absolute inset-0 bg-black/50"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={clsx('relative bg-white rounded-xl shadow-xl w-full', panelClassName)}
      >
        {children}
      </div>
    </div>
  )
}
