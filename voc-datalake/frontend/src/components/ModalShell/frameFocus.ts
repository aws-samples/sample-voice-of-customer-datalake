/**
 * @fileoverview Pure cross-document focus arithmetic for `ModalShell`.
 *
 * Everything in this module is a function of its arguments: none of it reads
 * component state, props or a ref. The doc comments travel with the code because
 * they record which defect each line prevents.
 *
 * @module components/ModalShell/frameFocus
 */


/**
 * What can hold focus at all, before asking whether it is actually visible.
 *
 * A module constant because the cheap pre-checks in `tabWouldLeave` and
 * `hasFocusable` need the same candidate set as `focusable` itself — two spellings
 * of this list would let a control count as an edge in one place and not in the
 * other.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])'

/** Candidates under `root` in DOM order, unfiltered — visibility is `reachable`'s job. */
export function focusCandidates(root: HTMLElement): HTMLElement[] {
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
export function reachable(root: HTMLElement, el: HTMLElement): boolean {
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
export function focusable(root: HTMLElement): HTMLElement[] {
  return focusCandidates(root).filter((el) => reachable(root, el))
}

/**
 * Whether `root` holds anything Tab can reach, without building the list.
 *
 * `focusable(root).length > 0` answers the same question, but pays for every
 * candidate in a document that may be a whole generated prototype page. The first
 * reachable one settles it.
 */
export function hasFocusable(root: HTMLElement): boolean {
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
export function frameDocument(frame: HTMLIFrameElement): Document | null {
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
export function asFrame(el: Element | null): HTMLIFrameElement | null {
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
export function asElement(node: Node): Element | null {
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
export function isFrameNode(node: unknown): boolean {
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
export function holdsFrame(node: Node): boolean {
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
export function hostFrame(doc: Document): HTMLIFrameElement | null {
  return asFrame(doc.defaultView?.frameElement ?? null)
}

/**
 * Every same-origin document nested under `root`, at any depth — the documents a
 * keydown can be raised in while focus is somewhere inside this dialog.
 */
export function nestedDocuments(root: HTMLElement): Document[] {
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
export function tabWouldLeave(doc: Document, back: boolean): boolean {
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
export function tabOutOfFrame(
  frame: HTMLIFrameElement,
  panelDocument: Document,
  items: HTMLElement[],
  back: boolean,
): HTMLElement | null {
  const owner = frame.ownerDocument
  // The panel is identified by an explicit argument, independent of whether
  // `items` happens to be empty or stale.
  if (owner === panelDocument) {
    const at = items.indexOf(frame)
    // A frame not in `items` at all (hidden, or the panel re-rendered under us):
    // position 0 keeps focus inside the panel rather than guessing.
    const from = at === -1 ? 0 : at
    return items[(from + (back ? -1 : 1) + items.length) % items.length] ?? null
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
  return outer ? tabOutOfFrame(outer, panelDocument, items, back) : items[0] ?? null
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
export function tabAcrossFrame(
  doc: Document,
  panelDocument: Document,
  items: HTMLElement[],
  back: boolean,
  isListened: (doc: Document) => boolean,
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
  return frame ? tabOutOfFrame(frame, panelDocument, items, back) : items[0]
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
export function tabWouldEnterFrame(
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
export function tabWithinPanel(
  items: HTMLElement[], active: Element | null, back: boolean, isListened: (doc: Document) => boolean,
): HTMLElement | null {
  if (tabWouldEnterFrame(active, back, isListened)) return null
  const first = items[0]
  const last = items[items.length - 1]
  if (back && active === first) return last
  if (!back && active === last) return first
  return null
}
