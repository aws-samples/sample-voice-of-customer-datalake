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
 * in the panel as well, at any depth, and re-attached as frames load or arrive.
 * Each nested document is watched in its own right, because a frame inserted or
 * navigated INSIDE one is invisible to the panel's own observer — a frame's document
 * is not part of its embedder's node tree. A document that leaves the frame tree is
 * dropped on the next scan rather than at close, so a prototype swapping an embedded
 * frame does not accumulate a watcher per swap.
 *
 * The trap also has to let Tab move INTO such a frame. Descending into a frame is
 * the browser's DEFAULT action for a Tab pressed while the frame element has focus,
 * so the wrap's `preventDefault()` cancels it — and when the frame is the panel's
 * last focusable, which is the prototype overlay's shape, the wrap fires on exactly
 * that keypress and the frame's content is unreachable by keyboard. See
 * `tabWouldEnterFrame`, which descends only into a frame this shell is actually
 * listening to, so that the Tab which eventually leaves it is seen.
 *
 * Leaving a frame resumes at the item after it in the frame's OWN document, walking
 * outward and wrapping only at the panel — see `tabOutOfFrame`. Resuming at the panel
 * from any depth would skip whatever followed a nested frame inside the prototype.
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
import {
  focusable,
  holdsFrame,
  isFrameNode,
  nestedDocuments,
  tabAcrossFrame,
  tabWithinPanel,
} from './frameFocus'

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
    /**
     * Captured ONCE per open, and everything below is keyed on it: the top-most check
     * compares against it, the `load` listener and the MutationObserver attach to it,
     * and `listenToFrames` searches it.
     *
     * Valid for the lifetime of an open dialog because the panel is rendered
     * unconditionally while open, so React keeps the same DOM node. That became
     * load-bearing when this effect's deps narrowed to `[isOpen]`: an inline `onClose`
     * used to re-run it on nearly every render, which refreshed the capture constantly
     * and made a stale one impossible. What would break it now is unremarkable — giving
     * the panel a `key` that changes, or making the panel `<div>` itself conditional so
     * React unmounts and remounts it — and it would break silently: the observer would
     * watch a detached node and `topMostShell()` would never match, so Escape and the trap
     * would simply stop.
     *
     * NOT `{children}` becoming conditional, which an earlier draft of this comment named:
     * `panelRef` is on the panel `<div>` and `{children}` renders inside it, so emptying
     * the children leaves the same element mounted and the capture stays valid. Review
     * caught the wrong example, and a wrong example in a comment about an invariant is
     * worse than none — it teaches the next reader to guard the wrong edit.
     */
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
        ? tabWithinPanel(items, document.activeElement, e.shiftKey, isListened)
        : tabAcrossFrame(raisedIn, items, e.shiftKey, isListened)
      if (next === null) return
      e.preventDefault()
      next.focus()
    }
    // Every document a key can be raised in while focus is inside this dialog:
    // this page's, plus each same-origin frame's. Without the frames, Escape and
    // the trap go quiet as soon as focus enters one — see NESTED FRAMES above.
    const listening = new Map<Document, (e: KeyboardEvent) => void>()
    // Read by the Tab handlers: descending into a frame is only safe if a Tab raised
    // inside it comes back to us, which requires a listener on ITS document.
    const isListened = (doc: Document) => listening.has(doc)
    /**
     * Attach to any document not already covered. Idempotent, because it runs again
     * whenever the panel's contents change; a frame navigation REPLACES a document
     * rather than mutating it, so the new one is picked up here and the old one is
     * dropped by `reap`.
     *
     * Each nested document is watched in its OWN right, not just scanned once: a
     * script in the prototype can insert or navigate a frame inside it, and neither
     * the observer on the panel's subtree nor the panel's capture-phase `load` sees
     * that — a frame's internal document is not part of its embedder's node tree, and
     * a `load` dispatched inside one does not reach the panel. Without this, such a
     * frame was readable but unlistened, and `tabWouldEnterFrame` would have let a
     * keyboard user descend into it with nothing to bring them back out.
     */
    const watching = new Map<Document, MutationObserver>()
    const listen = (docs: readonly Document[]) => {
      for (const doc of docs) {
        if (listening.has(doc)) continue
        const handler = keyHandlerFor(doc)
        doc.addEventListener('keydown', handler)
        listening.set(doc, handler)
        // Skipped for `document`, whose triggers are attached to the panel below —
        // narrower than this whole page's tree, and already in place.
        if (doc !== document && doc.body) {
          doc.addEventListener('load', onFrameLoad, true)
          const nested = new MutationObserver(onFrameMutation)
          nested.observe(doc.body, { childList: true, subtree: true })
          watching.set(doc, nested)
        }
      }
    }
    /** Undo everything `listen` attached for one document. */
    const forget = (doc: Document) => {
      const handler = listening.get(doc)
      if (handler) doc.removeEventListener('keydown', handler)
      listening.delete(doc)
      watching.get(doc)?.disconnect()
      watching.delete(doc)
      if (doc !== document) doc.removeEventListener('load', onFrameLoad, true)
    }
    /**
     * Drop the documents that are no longer in the panel's frame tree.
     *
     * A frame that is REPLACED or navigated leaves its old document unreachable but
     * still attached to, and a `MutationObserver` is not something to leave for the
     * dialog's whole open lifetime: it holds the detached body it watches alive, and a
     * prototype that swaps an embedded frame accumulated one per swap. Reaping also
     * keeps `isListened` honest, which the Tab guards depend on — a document that is
     * gone must not read as a safe place to send focus.
     *
     * `live` is narrower than "still in the frame tree", and review was right to name it:
     * it is what `nestedDocuments` could READ on this pass, which also excludes a frame
     * that is merely mid-navigation or mid-`document.write` and has no `body` yet. Such a
     * document is dropped here and re-listened on its next `load`, so there is a window
     * where a LIVE frame reads as unlistened. That window fails closed — the entry guard
     * declines to descend and Tab wraps into the panel instead — which is why this is
     * recorded rather than fixed. Discriminating the two states would mean asking
     * `doc.defaultView === null` for "really gone", and buying a narrower reap with a
     * second notion of liveness is a worse trade than a wrap that is momentarily early.
     */
    const reap = (live: readonly Document[]) => {
      const keep = new Set(live)
      for (const doc of [...listening.keys()]) {
        if (doc !== document && !keep.has(doc)) forget(doc)
      }
    }
    // A frame's document may not exist yet on this commit — the prototype overlay's
    // frame mounts with the dialog, and other content arrives with a query — so the
    // scan is repeated when the panel's subtree changes and when a frame loads
    // (`load` does not bubble, but a capture-phase listener on the panel sees it).
    const listenToFrames = () => {
      // Cheap negative for the overwhelming majority of dialogs, which hold no frame
      // at all: this runs on every mutation inside the panel, including the ones a
      // form's own re-renders produce. Nothing to reap for those either — `listening`
      // holds only `document` until a frame is found.
      if (panel.querySelector('iframe') === null && listening.size <= 1) return
      const live = nestedDocuments(panel)
      reap(live)
      listen(live)
    }
    /**
     * The two triggers, FILTERED. Review found both unfiltered, and both re-ran the
     * recursive `nestedDocuments(panel)` walk for events that cannot change the answer:
     *
     *  - a capture-phase `load` on a prototype's own document fires for every image,
     *    script and stylesheet in it, so a page with 200 assets paid 200 walks;
     *  - the observer's callback took no arguments, so it ignored its records — any text
     *    edit, class toggle or re-render anywhere inside the prototype re-walked the tree.
     *
     * The cheap `panel.querySelector('iframe')` negative in `listenToFrames` does not help
     * this consumer: the overlay's panel always holds a frame, so that guard is false
     * exactly when the cost is highest. Only a frame arriving, leaving or loading can
     * change which documents there are to listen to, so only those get a walk.
     *
     * ONE REPLACEMENT ROUTE IS SEEN BY NEITHER TRIGGER, unchanged by this filtering but
     * worth naming here because the filter is where a reader will look for it: a prototype
     * that rewrites itself through `document.open()`/`write()`/`close()` fires no `load` on
     * the frame element and produces no childList record this observer can act on.
     *
     * Measured in jsdom, and the measurement is misleading in the SAFE direction, so read
     * the spec rather than the test: `document.open()` REUSES the Document object, and
     * jsdom leaves our keydown listener attached, so a rewritten prototype keeps working
     * there. The HTML standard's "document open steps" say otherwise — they erase all
     * event listeners on each shadow-including INCLUSIVE descendant of the document, the
     * document itself included. In a compliant browser the object therefore stays in
     * `listening` while its listener is gone, so `isListened` answers TRUE for a document
     * nothing is listening to and the entry guard lets Tab descend into a frame that cannot
     * hand focus back. That fails OPEN, which is the opposite of what it looks like.
     *
     * Not fixed here, deliberately, and tracked as **issue #386**: the fix is to stop
     * treating `listening.has(doc)` as proof of an attached listener (re-assert the stored
     * handler on each scan, and re-observe when `doc.body` is a different object), which
     * changes this shell's idempotency contract for every dialog in the app — and jsdom
     * cannot host a test for either the bug or the fix, so it cannot ship with a guard that
     * fails on revert. #386 carries the browser reproduction and the spec citation.
     *
     * These three arrows and `listenToFrames` reference each other, so they are `const`
     * arrows read before the line that defines them — legal because nothing here runs
     * until an event fires, and kept mutually referential on purpose: making any of them
     * a hoisted `function` would put the pair on two different declaration styles for no
     * reason, and inlining them into the `addEventListener` calls would break `forget`,
     * which needs the identical reference to detach.
     */
    const onFrameLoad = (e: Event) => {
      if (isFrameNode(e.target)) listenToFrames()
    }
    const onFrameMutation = (records: readonly MutationRecord[]) => {
      const moved = (nodes: NodeList) => [...nodes].some(holdsFrame)
      if (records.some((r) => moved(r.addedNodes) || moved(r.removedNodes))) listenToFrames()
    }
    listen([document])
    listenToFrames()
    panel.addEventListener('load', onFrameLoad, true)
    const frames = new MutationObserver(onFrameMutation)
    frames.observe(panel, { childList: true, subtree: true })
    return () => {
      frames.disconnect()
      panel.removeEventListener('load', onFrameLoad, true)
      // Through `forget`, so a document detached here and one reaped mid-open are
      // undone by the same code and cannot drift apart.
      for (const doc of [...listening.keys()]) forget(doc)
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
