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
 * STACKING: Escape and Tab are handled in one document-level listener that acts
 * only for the top-most open shell, determined by document position (see
 * `openShells`). ConfirmModal is used as an unsaved-changes guard inside other
 * modals, so shells nest; an unguarded document listener would let one Escape
 * close both dialogs, and would let shift-Tab in the inner dialog yank focus into
 * the outer panel. This is also why Escape is handled here rather than via
 * useEscapeKey — that hook is unguarded by design.
 *
 * FOCUS: initial focus lands on the first focusable descendant (for ConfirmModal
 * that is Cancel, deliberately the non-destructive choice). Introducing an
 * `initialFocusRef` would change that, so it is stated here rather than implied.
 *
 * NESTED FRAMES: a keydown raised inside an `<iframe>`'s own document does NOT
 * propagate to the embedder — different document, different event target tree — so
 * a listener on this document alone stops seeing keys the moment focus enters a
 * frame, and an `<iframe>` is itself in `focusable()`'s selector list, so one Tab
 * can put it there. That made Escape and the Tab trap inert for the whole useful
 * life of a panel whose content IS a frame (the prototype enlarge overlay, #314).
 * The keydown listener is therefore attached to every same-origin document nested
 * in the panel as well, and re-attached as frames load or arrive.
 *
 * The trap also has to let Tab move INTO such a frame. Descending into a frame is
 * the browser's DEFAULT action for a Tab pressed while the frame element has focus,
 * so the wrap's `preventDefault()` cancels it — and when the frame is the panel's
 * last focusable, which is the prototype overlay's shape, the wrap fires on exactly
 * that keypress and the frame's content is unreachable by keyboard. See
 * `tabWouldEnterFrame`.
 *
 * A frame the parent cannot reach into — cross-origin, or sandboxed without
 * `allow-same-origin` — keeps the old behaviour in both directions, because there is
 * no way to observe its keys at all: its keys are invisible, and letting Tab descend
 * into it would strand a keyboard user with nothing to bring them back. A consumer
 * embedding one of those must render its own visible dismiss control; nothing here
 * can substitute for it.
 *
 * @module components/ModalShell
 */
import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'

interface ModalShellBaseProps {
  readonly isOpen: boolean
  readonly onClose: () => void
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
 * The dialog's accessible name, as a union so that supplying NEITHER is a type
 * error rather than a documented rule. Two optional props would let a caller omit
 * both and get an unnamed dialog — precisely the defect this shell exists to
 * prevent, and the reason the name is required at all.
 *
 * - `ariaLabel` is a plain string, never a node, so the name cannot resolve to
 *   empty. An earlier draft rendered the title into a hidden element and pointed
 *   aria-labelledby at it, which produced a NAMELESS dialog whenever the title was
 *   a ReactNode. The visible heading stays in `children`.
 * - `ariaLabelledBy` is preferred when a heading already exists: the name cannot
 *   drift from what is on screen, and no separate translatable string is added.
 *
 * `?: never` on the unused side keeps object literals from satisfying both arms.
 */
type ModalShellNameProps =
  | { readonly ariaLabel: string; readonly ariaLabelledBy?: never }
  | { readonly ariaLabelledBy: string; readonly ariaLabel?: never }

type ModalShellProps = ModalShellBaseProps & ModalShellNameProps

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
  // Styles are resolved through the element's OWN view, because `root` can be a
  // nested frame's body (see `tabWouldLeave`) and a document has no obligation to
  // compute styles for elements it does not own.
  const styleOf = (el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el)
  // NB: deliberately not using offsetParent — jsdom does no layout and returns
  // null for every element, which would filter the list empty under test.
  /**
   * Walks up to `root`, short-circuiting on the first hidden ancestor. Recursive
   * rather than a loop because `no-restricted-syntax` bans mutable bindings here,
   * and without building an intermediate array — this runs per candidate on every
   * Tab keypress.
   */
  const hiddenByAncestor = (el: HTMLElement): boolean =>
    styleOf(el).display === 'none' ||
    (el !== root && el.parentElement !== null && hiddenByAncestor(el.parentElement))
  return [...candidates].filter((el) => {
    if (el.closest('[hidden]') !== null || el.closest('[aria-hidden="true"]') !== null) return false
    if (el.closest('details:not([open])') !== null) return false
    if (styleOf(el).visibility === 'hidden') return false
    return !hiddenByAncestor(el)
  })
}

/**
 * The document inside a frame, or null when this page is not allowed to see it.
 *
 * Cross-origin frames throw on access, and a `sandbox` without `allow-same-origin`
 * (how legacy `srcDoc` prototypes are rendered) makes an otherwise same-origin
 * frame opaque too. Both are unobservable rather than merely awkward: nothing here
 * can see keys pressed inside them, which is why the header tells consumers
 * embedding one to render their own visible dismiss control.
 */
function frameDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument
  } catch {
    return null
  }
}

/**
 * `el` as a frame, or null if it is not one.
 *
 * The realm-aware `instanceof`, and it has to be: an element inside a frame belongs
 * to the FRAME's realm, whose `HTMLIFrameElement` is a different constructor object
 * from this document's, so a plain `el instanceof HTMLIFrameElement` is false for a
 * frame nested inside another frame. That is the same trap `raisedIn` avoids for
 * `Document` in the keydown handler, and it fails in the direction that hurts: the
 * frame is silently treated as an ordinary element, so `tabWouldEnterFrame` declines
 * and the descent is cancelled.
 */
function asFrame(el: Element | null): HTMLIFrameElement | null {
  if (el === null) return null
  const ctor = el.ownerDocument.defaultView?.HTMLIFrameElement ?? HTMLIFrameElement
  return el instanceof ctor ? el : null
}

/**
 * Every same-origin document nested under `root`, at any depth — the documents a
 * keydown can be raised in while focus is somewhere inside this dialog.
 */
function nestedDocuments(root: HTMLElement): Document[] {
  return [...root.querySelectorAll('iframe')].flatMap((frame) => {
    const doc = frameDocument(frame)
    // Truthiness rather than a null check: `Document['body']` is typed non-null,
    // but a frame that has not finished loading genuinely has none yet.
    if (!doc?.body) return []
    return [doc, ...nestedDocuments(doc.body)]
  })
}

/**
 * Whether a Tab pressed inside `doc` would leave it — i.e. focus is already on
 * that document's last focusable (or its first, going backwards).
 *
 * A frame with nothing focusable counts as leaving: the key cannot move focus
 * within it, so the browser would hand focus to whatever follows the frame.
 *
 * That covers two states the DOM cannot tell apart, deliberately treated alike.
 * A frame LOADED with no controls in it is the case above. A frame still loading
 * has no `body` yet, and so reaches the same answer by a different route — a Tab in
 * those first moments is treated as an exit and wrapped back into the panel rather
 * than allowed to descend into a document that does not exist. That is the safe
 * reading of both: there is nothing to descend into either way, and it self-corrects
 * on `load`, which is also when the frame's own listener is attached
 * (`nestedDocuments` returns nothing for a body-less document for the same reason).
 * If the two ever need to diverge, `body` alone cannot separate them —
 * `doc.readyState` is what distinguishes "loading" from "complete and empty".
 */
function tabWouldLeave(doc: Document, back: boolean): boolean {
  // See `nestedDocuments` on why `body` is checked despite its non-null type.
  const items = doc.body ? focusable(doc.body) : []
  if (items.length === 0) return true
  return doc.activeElement === (back ? items[0] : items[items.length - 1])
}

/**
 * Where Tab should go when the key came from inside a nested frame, or null to
 * leave it to that frame.
 *
 * Inside the frame it is the frame's business: intervening on every Tab would
 * yank a reviewer out of a prototype they are walking through. Only at the frame's
 * own last (or first) control does this take over, and then it steps to the panel
 * item after the frame rather than to the panel's edge — the frame is one stop in
 * the panel's order, not necessarily its final one. `active` is this document's
 * activeElement, which is the `<iframe>` ELEMENT while focus is inside it.
 */
function tabAcrossFrame(
  doc: Document, items: HTMLElement[], active: Element | null, back: boolean,
): HTMLElement | null {
  // Entry is checked on THIS path too, against `doc`'s own activeElement: a frame
  // nested inside a frame (a generated prototype embedding a map, a video or a docs
  // frame) is that document's last focusable, so it would otherwise be read as an
  // exit and wrapped — cancelling the descent, which is the very defect
  // `tabWouldEnterFrame` exists to prevent, one level down. Recursion makes the rest
  // work: `nestedDocuments` attaches to frames at any depth, so the Tab that leaves
  // the inner frame is seen here in turn.
  if (tabWouldEnterFrame(doc.activeElement, back)) return null
  if (!tabWouldLeave(doc, back)) return null
  const at = active instanceof HTMLElement ? items.indexOf(active) : -1
  // A frame nested deeper than the panel's own children is not in `items`; treat
  // it as position 0, which still keeps focus inside the panel.
  const from = at === -1 ? 0 : at
  return items[(from + (back ? -1 : 1) + items.length) % items.length]
}

/**
 * Whether a forward Tab is about to move focus INTO a frame's own content, and so
 * must be left to the browser.
 *
 * This is the other half of `tabAcrossFrame`, and the one the trap gets wrong by
 * default. While an `<iframe>` ELEMENT has focus the browser's next Tab descends
 * into that frame's first control — a default action, so any `preventDefault()`
 * cancels it. When the frame is the panel's LAST focusable (`[Close, <iframe>]`,
 * which is exactly the prototype enlarge overlay's shape) the wrap fires on that
 * very keypress: `active === last`, focus is sent back to the panel's first item,
 * and the descent never happens. Close ⇄ frame element for ever, with every link
 * inside the artifact keyboard-unreachable — in the dialog that exists to walk
 * through that artifact.
 *
 * Declining here is safe because the frame is not an exit: a Tab at the frame's own
 * last control is raised in the frame's document and `tabAcrossFrame` brings focus
 * back to the panel item after the frame. Focus is inside the dialog throughout.
 *
 * Only when the frame's content is REACHABLE, though. An opaque frame
 * (cross-origin, or sandboxed without `allow-same-origin`) has no listener of ours
 * inside it, so nothing would bring focus back out and declining would hand the
 * page behind the overlay a keyboard user; the same goes for a frame with nothing
 * focusable in it, where the browser skips straight past to whatever follows.
 * Both keep the wrap.
 *
 * Backwards is deliberately not included: shift-Tab from a focused frame element
 * moves to what precedes the frame rather than descending, so there is no default
 * action to protect.
 *
 * Consulted on BOTH Tab paths, against whichever document raised the key: from
 * `tabWithinPanel` for a frame that is a panel focusable, and from `tabAcrossFrame`
 * for one nested inside another frame's document. The two are the same defect at
 * different depths — a prototype is generated HTML and may embed a frame of its own
 * without anyone choosing to — so the guard is not scoped to the panel's own level.
 *
 * A frame the parent cannot read into is opaque at every depth, so an opaque frame
 * inside a readable one keeps the wrap for the reason above: it would still be a
 * one-way trip.
 */
function tabWouldEnterFrame(active: Element | null, back: boolean): boolean {
  const frame = back ? null : asFrame(active)
  if (frame === null) return false
  const doc = frameDocument(frame)
  // See `nestedDocuments` on why `body` is checked despite its non-null type.
  return doc?.body ? focusable(doc.body).length > 0 : false
}

/** Where Tab must go to stay in the panel, or null when the panel's own order suffices. */
function tabWithinPanel(items: HTMLElement[], active: Element | null, back: boolean): HTMLElement | null {
  if (tabWouldEnterFrame(active, back)) return null
  const first = items[0]
  const last = items[items.length - 1]
  if (back && active === first) return last
  if (!back && active === last) return first
  return null
}

/**
 * Every open shell's panel. Only the top-most reacts to Escape and Tab.
 *
 * Two rejected approaches, both of which failed silently:
 *
 * 1. `panel.contains(document.activeElement)` — disabled BOTH Escape and the Tab
 *    trap whenever focus left the panel, which happens in ordinary flows: the
 *    focused control is removed or becomes disabled (browsers drop focus to
 *    <body>), focus enters an iframe, or something calls blur().
 * 2. Registration order (last registered wins) — React runs CHILD effects before
 *    PARENT effects, so an outer modal that renders with a nested shell already
 *    open registers inner-then-outer, and Escape would close the OUTER dialog.
 *
 * Top-most is therefore derived from document position, which is independent of
 * both focus and mount order. A descendant follows its ancestor in document
 * order, so this is correct for nested and sibling shells alike.
 */
const openShells: HTMLElement[] = []

/** The open shell latest in document order, i.e. the one painted on top. */
function topMostShell(): HTMLElement | undefined {
  return openShells.reduce<HTMLElement | undefined>(
    (top, panel) =>
      top === undefined ||
      (top.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        ? panel
        : top,
    undefined,
  )
}

export default function ModalShell({
  isOpen,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  children,
  panelClassName,
  dismissable = true,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * The latest `onClose` and `dismissable`, read through a ref by the keydown
   * handler so that the listener wiring below can depend on `isOpen` alone.
   *
   * Consumers pass `onClose` as an inline arrow — `PrototypeEnlargeButton` does, and
   * so does most of this shell's usage — which is a fresh identity on every render.
   * With those in the effect's deps, ONE re-render of the component holding an open
   * dialog tore down and rebuilt everything the effect owns: the MutationObserver,
   * the capture-phase `load` listener, and a keydown listener on every nested frame
   * document. Symmetric, so nothing leaked, but it walked the frame tree per render
   * and left a brief window with no listener attached — under a page that re-renders
   * while an overlay is open (a query refetch, a slider move, the hourly re-signing
   * this overlay exists to survive), that window recurs indefinitely.
   */
  const onCloseRef = useRef(onClose)
  const dismissableRef = useRef(dismissable)
  useEffect(() => {
    onCloseRef.current = onClose
    dismissableRef.current = dismissable
  }, [onClose, dismissable])

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
    const panel = panelRef.current
    if (!panel) return
    /**
     * The handler as attached to ONE document.
     *
     * `raisedIn` is captured rather than read off `e.currentTarget`, because a
     * frame's Document belongs to the frame's realm: `currentTarget instanceof
     * Document` is false for it in a real browser, silently treating a frame's
     * keys as the page's own.
     */
    const keyHandlerFor = (raisedIn: Document) => (e: KeyboardEvent) => {
      // Only the top-most open dialog reacts — independent of focus and of the
      // order the shells happened to mount in.
      if (topMostShell() !== panel) return

      if (e.key === 'Escape') {
        // Through the refs, so this handler never has to be rebuilt to see a new
        // `onClose` — see the refs' comment on what rebuilding it costs.
        if (dismissableRef.current) onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return

      const items = focusable(panel)
      if (items.length === 0) return
      const next = raisedIn === document
        ? tabWithinPanel(items, document.activeElement, e.shiftKey)
        : tabAcrossFrame(raisedIn, items, document.activeElement, e.shiftKey)
      if (next === null) return
      e.preventDefault()
      next.focus()
    }
    // Every document a key can be raised in while focus is inside this dialog:
    // this page's, plus each same-origin frame's. Without the frames, Escape and
    // the trap go quiet as soon as focus enters one — see NESTED FRAMES above.
    const listening = new Map<Document, (e: KeyboardEvent) => void>()
    /**
     * Attach to any document not already covered. Idempotent, because it runs again
     * whenever the panel's contents change and a frame navigation REPLACES a
     * document rather than mutating it — the old entry is left in place, already
     * unreachable, and detached with the rest on close.
     */
    const listen = (docs: readonly Document[]) => {
      for (const doc of docs) {
        if (listening.has(doc)) continue
        const handler = keyHandlerFor(doc)
        doc.addEventListener('keydown', handler)
        listening.set(doc, handler)
      }
    }
    listen([document])
    // A frame's document may not exist yet on this commit — the prototype overlay's
    // frame mounts with the dialog, and other content arrives with a query — so the
    // scan is repeated when the panel's subtree changes and when a frame loads
    // (`load` does not bubble, but a capture-phase listener on the panel sees it).
    const listenToFrames = () => {
      // Cheap negative for the overwhelming majority of dialogs, which hold no frame
      // at all: this runs on every mutation inside the panel, including the ones a
      // form's own re-renders produce.
      if (panel.querySelector('iframe') === null) return
      listen(nestedDocuments(panel))
    }
    listenToFrames()
    panel.addEventListener('load', listenToFrames, true)
    const frames = new MutationObserver(listenToFrames)
    frames.observe(panel, { childList: true, subtree: true })
    return () => {
      frames.disconnect()
      panel.removeEventListener('load', listenToFrames, true)
      for (const [doc, handler] of listening) doc.removeEventListener('keydown', handler)
    }
    // `isOpen` alone: `onClose` and `dismissable` are read through refs, so a
    // consumer's inline arrow does not rebuild the observer and every frame
    // listener on each of its renders.
  }, [isOpen])

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
      {/* Exactly one of aria-label / aria-labelledby is defined (enforced by
          ModalShellNameProps), so neither needs to defer to the other — the
          unused one is undefined and renders as no attribute at all. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={clsx('relative bg-white rounded-xl shadow-xl w-full', panelClassName)}
      >
        {children}
      </div>
    </div>
  )
}
