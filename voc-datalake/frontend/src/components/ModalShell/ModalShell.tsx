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
 * What can hold focus at all, before asking whether it is actually visible.
 *
 * A module constant because the cheap pre-checks in `tabWouldLeave` and
 * `hasFocusable` need the same candidate set as `focusable` itself — two spellings
 * of this list would let a control count as an edge in one place and not in the
 * other.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])'

/** Candidates under `root` in DOM order, unfiltered — visibility is `reachable`'s job. */
function focusCandidates(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
}

/**
 * Whether a focus candidate under `root` is actually reachable by Tab.
 *
 * `display:none` must be checked up the ancestor chain: computed `display` of a
 * child inside a hidden container is the child's own value, so checking only the
 * element itself misses the motivating case — collapsible sections hide the
 * container, not each control. `visibility:hidden` inherits, so one check does.
 *
 * This is the expensive half — three `closest()` walks plus at least one style
 * resolution per element, and `hiddenByAncestor` recurses to `root` — which is why
 * callers that only need "is there one" or "is this an edge" short-circuit rather
 * than building the whole filtered list. See `tabWouldLeave`.
 */
function reachable(root: HTMLElement, el: HTMLElement): boolean {
  // Styles are resolved through the element's OWN view, because `root` can be a
  // nested frame's body (see `tabWouldLeave`) and a document has no obligation to
  // compute styles for elements it does not own.
  const styleOf = (target: Element) =>
    (target.ownerDocument.defaultView ?? window).getComputedStyle(target)
  // NB: deliberately not using offsetParent — jsdom does no layout and returns
  // null for every element, which would filter the list empty under test.
  /**
   * Walks up to `root`, short-circuiting on the first hidden ancestor. Recursive
   * rather than a loop because `no-restricted-syntax` bans mutable bindings here,
   * and without building an intermediate array — this runs per candidate on every
   * Tab keypress.
   */
  const hiddenByAncestor = (target: HTMLElement): boolean =>
    styleOf(target).display === 'none' ||
    (target !== root && target.parentElement !== null && hiddenByAncestor(target.parentElement))
  if (el.closest('[hidden]') !== null || el.closest('[aria-hidden="true"]') !== null) return false
  if (el.closest('details:not([open])') !== null) return false
  if (styleOf(el).visibility === 'hidden') return false
  return !hiddenByAncestor(el)
}

/** Focusable descendants in DOM order, excluding anything not actually reachable. */
function focusable(root: HTMLElement): HTMLElement[] {
  return focusCandidates(root).filter((el) => reachable(root, el))
}

/**
 * Whether `root` holds anything Tab can reach, without building the list.
 *
 * `focusable(root).length > 0` answers the same question, but pays for every
 * candidate in a document that may be a whole generated prototype page. The first
 * reachable one settles it.
 */
function hasFocusable(root: HTMLElement): boolean {
  return focusCandidates(root).some((el) => reachable(root, el))
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
 * `node` as an element, resolved in the node's OWN realm — `asFrame` one type up.
 *
 * Needed because the mutation filter is handed `Node`s, and the nodes moved inside a
 * prototype belong to its realm: a plain `node instanceof Element` is false for every
 * one of them, so a filter built on it would quietly pass nothing through and the frame
 * bookkeeping would stop happening. A `Document` has no `ownerDocument`, and is not an
 * element either, so the page's constructor is a safe fallback that answers null.
 */
function asElement(node: Node): Element | null {
  const ctor = node.ownerDocument?.defaultView?.Element ?? Element
  return node instanceof ctor ? node : null
}

/**
 * Whether a node is a frame element, decided without narrowing it first.
 *
 * `asFrame` needs an `Element`, and the two callers here hold an `EventTarget` (a
 * `load`'s target) and a `Node` (a mutation record's), neither of which narrows to
 * `Element` without the cross-realm `instanceof` this exists to avoid or a type
 * assertion the repo bans. `tagName` is realm-independent — `'IFRAME'` in every HTML
 * document — and `Reflect.get` reads it off an unknown without assuming a shape.
 *
 * DELIBERATELY STRUCTURAL, and NOT equivalent to `asFrame`, which is constructor-based:
 * this answers a name, so it would also accept an element in an XML-ish document whose
 * tag name happens to uppercase to `IFRAME`, and it says nothing about `<frame>` or
 * `<object>`. That is the intended scope — only `<iframe>` is embedded by anything this
 * shell renders, and both callers use the answer to decide whether to RE-SCAN, where a
 * false positive costs one extra walk and `nestedDocuments` settles what is really there.
 * Where the answer decides focus behaviour instead, `asFrame` is still the one to use.
 */
function isFrameNode(node: unknown): boolean {
  return typeof node === 'object' && node !== null && Reflect.get(node, 'tagName') === 'IFRAME'
}

/**
 * Whether a moved node IS a frame or CONTAINS one.
 *
 * Both halves matter: `body.innerHTML = '<div><iframe/></div>'` reports the DIV as the
 * added node, which is the shape a prototype's own script produces, so asking only about
 * the node itself would miss the frame it brought with it and leave that document
 * unlistened.
 */
function holdsFrame(node: Node): boolean {
  if (isFrameNode(node)) return true
  const el = asElement(node)
  return el !== null && el.querySelector('iframe') !== null
}

/**
 * The frame element hosting `doc`, or null when `doc` is not in a frame this page
 * can reach out of.
 *
 * `frameElement` is the only way back OUT of a document: a frame's own document has
 * no other reference to the element embedding it, and the element belongs to the
 * PARENT's realm, which is why it goes through `asFrame` rather than a bare
 * `instanceof`.
 */
function hostFrame(doc: Document): HTMLIFrameElement | null {
  return asFrame(doc.defaultView?.frameElement ?? null)
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
 *
 * `doc` here is a whole page rather than a dialog panel, and this runs on EVERY Tab
 * a reviewer presses while walking through a prototype — where the answer is "no"
 * for all but the last one. So it is answered WITHOUT building the filtered list:
 * the question is only whether any reachable control lies beyond the focused one, and
 * the first one found settles it. Building the list instead resolved styles and ran
 * three `closest()` walks for every control in the document on each keypress (2800
 * style resolutions for a 400-control prototype), all of it to answer "no".
 *
 * Reachability is still what decides — checking raw DOM position instead would be
 * wrong, not merely approximate: with the document's last candidate hidden, the last
 * REACHABLE control is interior to the raw list, and a Tab there does leave.
 */
function tabWouldLeave(doc: Document, back: boolean): boolean {
  // See `nestedDocuments` on why `body` is checked despite its non-null type.
  const body = doc.body
  if (!body) return true
  const candidates = focusCandidates(body)
  const active = doc.activeElement
  // `findIndex` on identity rather than `indexOf` after an `instanceof HTMLElement`
  // narrowing: `active` belongs to THIS document's realm, whose `HTMLElement` is a
  // different constructor object from the page's, so the narrowing is false for every
  // element in a frame and every position would resolve to -1. Same trap as `asFrame`,
  // and it failed silently — the trap simply never fired inside a frame.
  const at = candidates.findIndex((el) => el === active)
  // Focus is not on a candidate at all — `<body>` itself, or a control this selector
  // does not cover. It is then not an edge in either direction, so the key remains this
  // document's business unless there is nothing here Tab can REACH at all.
  //
  // REACHABLE, not raw, and that distinction is the whole of this branch. Both reviewers
  // caught the refactor getting it wrong: a generated prototype's unopened modal or
  // inactive screen lives in a `display:none` container, so its controls exist as
  // candidates while none of them can be tabbed to. `candidates.length === 0` then
  // answers "there is something here to move between", the shell declines to intervene,
  // and the browser moves focus past the frame into the page behind the dialog — the
  // very escape `tabWouldEnterFrame` prevents on the frame-element path via
  // `hasFocusable`, reached instead through the in-frame keydown path once a click has
  // put focus inside the prototype. Reproduced in jsdom before fixing: raw 2, reachable
  // 0, where the pre-refactor `focusable(body).length === 0` correctly said "leaving".
  //
  // `some` over the list already built, rather than `hasFocusable(body)` — which is the
  // same predicate and reads as the tidier call, but re-runs `querySelectorAll` over a
  // whole prototype document that `candidates` has just walked. Keeping the short-circuit
  // without paying for a second query is the point of this branch's shape.
  if (at === -1) return !candidates.some((el) => reachable(body, el))
  // Whatever the key could still reach inside `doc`, in the direction it is going. One
  // reachable control among them settles the question, so `some` stops at the first
  // rather than filtering every control in the document.
  const ahead = back ? candidates.slice(0, at) : candidates.slice(at + 1)
  return !ahead.some((el) => reachable(body, el))
}

/**
 * The next focusable OUTSIDE `frame`, walking outward one document at a time.
 *
 * A frame is one stop in its own document's order, so leaving it resumes at the item
 * after it THERE — not at the panel, which is only the right answer when the frame is
 * a panel focusable. Reading the top document's activeElement instead (which is the
 * outermost frame element whenever focus is anywhere inside it) collapsed every depth
 * to the panel's order, so an exit from a frame nested inside the prototype skipped
 * whatever followed it in the prototype's own document and jumped focus out of the
 * artifact entirely.
 *
 * Recursive rather than a single step because the frame may be its document's last
 * focusable, in which case leaving it leaves that document too, and so on outward.
 * The walk terminates at the panel's document, where `items` applies and the edges
 * wrap — that wrap is the trap, and is the only place one belongs.
 */
function tabOutOfFrame(
  frame: HTMLIFrameElement, items: HTMLElement[], back: boolean,
): HTMLElement | null {
  const owner = frame.ownerDocument
  if (owner === document) {
    const at = items.indexOf(frame)
    // A frame not in `items` at all (hidden, or the panel re-rendered under us):
    // position 0 keeps focus inside the panel rather than guessing.
    const from = at === -1 ? 0 : at
    return items[(from + (back ? -1 : 1) + items.length) % items.length]
  }
  // See `nestedDocuments` on why `body` is checked despite its non-null type.
  const siblings = owner.body ? focusable(owner.body) : []
  const at = siblings.indexOf(frame)
  // No wrap in an intermediate document: running off its edge means this Tab leaves
  // that document too, which is the recursion below, not a jump to its other end.
  const next = siblings[at + (back ? -1 : 1)]
  if (at !== -1 && next) return next
  // Nothing after it here either, so this Tab leaves the intermediate document too.
  const outer = hostFrame(owner)
  // `items[0]` when the walk runs out of enclosing frames without reaching this
  // document — see `tabAcrossFrame`'s fallback for the route that produces it and why
  // moving focus beats declining.
  return outer ? tabOutOfFrame(outer, items, back) : items[0]
}

/**
 * Where Tab should go when the key came from inside a nested frame, or null to
 * leave it to that frame.
 *
 * Inside the frame it is the frame's business: intervening on every Tab would
 * yank a reviewer out of a prototype they are walking through. Only at the frame's
 * own last (or first) control does this take over, and then it steps to whatever
 * follows the frame in the frame's OWN document, walking outward to the panel only
 * when the frame is that document's edge too — see `tabOutOfFrame`.
 */
function tabAcrossFrame(
  doc: Document, items: HTMLElement[], back: boolean, isListened: (doc: Document) => boolean,
): HTMLElement | null {
  // Entry is checked on THIS path too, against `doc`'s own activeElement: a frame
  // nested inside a frame (a generated prototype embedding a map, a video or a docs
  // frame) is that document's last focusable, so it would otherwise be read as an
  // exit and wrapped — cancelling the descent, which is the very defect
  // `tabWouldEnterFrame` exists to prevent, one level down.
  if (tabWouldEnterFrame(doc.activeElement, back, isListened)) return null
  if (!tabWouldLeave(doc, back)) return null
  const frame = hostFrame(doc)
  // No host frame to step out of. Not a modelled state — every document listened to was
  // found THROUGH a frame element — but it has one route: a frame detached (or navigated)
  // between the listener being attached and this key being handled, which discards its
  // browsing context and leaves `defaultView` null. `reap` closes that window on the next
  // scan, so what remains is the key already in flight.
  //
  // The panel's first item rather than `null`, on the same fail-closed reasoning as the
  // `at === -1` branch in `tabOutOfFrame`: the document this key came from no longer
  // exists, so declining hands the Tab to a browser with nowhere sensible to put focus —
  // which means outside the dialog. A wrong stop inside the panel is recoverable with
  // another Tab; leaving the dialog is not.
  return frame ? tabOutOfFrame(frame, items, back) : items[0]
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
 * Declining here is safe only when a Tab inside the frame will come back to us: the
 * exit is `tabAcrossFrame`, and it runs from a listener on the frame's OWN document.
 * So the guard requires that document to be one this shell is currently LISTENING to,
 * not merely one it can read. Readability is necessary but not sufficient — a frame
 * inserted into another frame's document after that document was scanned is readable
 * and unlistened, because both re-scan triggers (the MutationObserver on the panel's
 * subtree, and the capture-phase `load` on the panel) live in the top document and see
 * neither insertions into a nested document nor `load`s dispatched there. Declining for
 * one of those let a keyboard user descend into a frame nothing could bring them out
 * of, with Escape dead too — the trap silently ended at that frame.
 *
 * A frame with nothing focusable in it also keeps the wrap: the browser skips straight
 * past such a frame to whatever follows, so it is not an entry at all.
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
 *
 * @param isListened whether this shell has a keydown listener on a given document —
 *   i.e. whether an exiting Tab raised inside it would be seen.
 */
function tabWouldEnterFrame(
  active: Element | null, back: boolean, isListened: (doc: Document) => boolean,
): boolean {
  const frame = back ? null : asFrame(active)
  if (frame === null) return false
  const doc = frameDocument(frame)
  // See `nestedDocuments` on why `body` is checked despite its non-null type.
  if (!doc?.body) return false
  // `hasFocusable` rather than `focusable(...).length`: this also runs per keypress
  // over a whole prototype document, and one reachable control answers it.
  return isListened(doc) && hasFocusable(doc.body)
}

/** Where Tab must go to stay in the panel, or null when the panel's own order suffices. */
function tabWithinPanel(
  items: HTMLElement[], active: Element | null, back: boolean, isListened: (doc: Document) => boolean,
): HTMLElement | null {
  if (tabWouldEnterFrame(active, back, isListened)) return null
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
     * Not fixed here, deliberately: the fix is to stop treating `listening.has(doc)` as
     * proof of an attached listener (re-assert the stored handler on each scan, and
     * re-observe when `doc.body` is a different object), which changes this shell's
     * idempotency contract for every dialog in the app — and jsdom cannot host a test for
     * either the bug or the fix. Tracked separately rather than smuggled into this round.
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
