/**
 * @fileoverview One "Revise from comments" pass on the canvas (docs/document-review.md), from the button to its end:
 *
 * - `recommendations`: shown, nothing written;
 * - `proposal`: each change is accepted into the editor's draft (its exact `before` replaced once; out of date when
 *   the draft no longer holds it exactly once) or rejected; the person then Saves as for any edit, and after that save
 *   (the canvas's `lastSaved`) the accepted changes the saved text kept (the same occurrence of their new text, see
 *   reviseChanges) have their threads marked addressed by the saved version. A draft replaced without a save (Discard,
 *   Load the latest: the canvas's `generation` moves) puts every accepted change back to pending. Closing the panel
 *   while accepted changes are unsaved keeps them (`pendingMarks`): the next save still settles them, and a new pass
 *   waits until they are saved or discarded (`holdsAccepted`). A save whose text still keeps an accepted change is
 *   recorded as a revise (`markRevised`: the version's `edit_kind`, D4);
 * - `applied`: the server wrote the next version; the canvas reloads on it (asking first while it holds changes), and
 *   Undo restores the version the pass read through the History's restore route (a new version again), then takes
 *   the pass's "addressed" marks off its threads. When someone saved after the revision, Undo asks first: restoring
 *   the version the pass read would revert their change too.
 *
 * @module components/DocumentCanvas/revise/useRevisePass
 */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { projectsApi } from '../../../api/projectsApi'
import { projectKey } from '../../../api/projectQueryKeys'
import { serverReason } from '../../../lib/errors'
import { ignoreRejection } from '../../../lib/rejections'
import { keptChanges, NOTHING_PLACED, placeChange, relocate, threadIdsOf } from './reviseChanges'
import type { Placed } from './reviseChanges'
import type { ReviseFromCommentsResult } from '../../../api/documentReviewSchema'
import type { CanvasDocument } from '../actions/useCanvasDocument'

/**
 * What the page's canvas (useCanvasDocument) gives a pass: its last save, its generation, its reload, its selection,
 * and how its next save is recorded (a revise while the draft holds accepted changes).
 */
export type ReviseCanvas = Pick<CanvasDocument, 'lastSaved' | 'generation' | 'reloadLatest' | 'selectDoc' | 'markRevised'>

/** A proposed change: taken into the draft, turned down, or taken and saved (its threads marked addressed). */
export type Decision = 'accepted' | 'rejected' | 'addressed'

/** `confirm`: a version was saved after the revision; Undo waits for "Undo anyway" or "Keep it". */
export type UndoState = 'idle' | 'running' | 'confirm' | 'done' | 'failed'

export type RevisePass =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  /** `message`: the server's reason (no threads yet, a stale version); null: a generic failure. */
  | { readonly kind: 'failed'; readonly message: string | null }
  | { readonly kind: 'recommendations'; readonly result: ReviseFromCommentsResult }
  | {
    readonly kind: 'proposal'; readonly result: ReviseFromCommentsResult
    readonly decisions: Readonly<Record<string, Decision>>
    /** The last save's marking: how many threads, in which version (or that it failed). */
    readonly marked: { readonly count: number; readonly version: number } | 'failed' | null
  }
  | {
    readonly kind: 'applied'; readonly result: ReviseFromCommentsResult; readonly undo: UndoState
    /** While `confirm`: the version saved after the revision (the head now). */
    readonly newer?: number
  }

interface RevisePassArgs {
  readonly projectId: string
  readonly run: () => Promise<ReviseFromCommentsResult>
  /** Marks threads addressed by the saved version `documentId` (the server takes that version's number). */
  readonly markAddressed: (documentId: string, threadIds: readonly string[]) => Promise<unknown>
  /** Takes the "addressed" marks off threads (an undone revision answered them no more). */
  readonly clearAddressed: (documentId: string, threadIds: readonly string[]) => Promise<unknown>
  /** The canvas text now (the editor's own, flushed). */
  readonly draft: () => string
  /** Puts a text into the editor and the page's draft (the page is then dirty). */
  readonly putDraft: (markdown: string) => void
  readonly canvas: ReviseCanvas
}

type Proposal = Extract<RevisePass, { kind: 'proposal' }>
type Applied = Extract<RevisePass, { kind: 'applied' }>

/** The threads a save answered, to mark addressed by its version. */
interface ToMark {
  /** The pass they came from: its panel (if still open) says how the marking went. */
  readonly result: ReviseFromCommentsResult
  readonly documentId: string
  readonly threadIds: readonly string[]
  readonly version: number
}

type SavedVersion = NonNullable<ReviseCanvas['lastSaved']>

/** The proposal's changes taken into the draft and not saved yet. */
const acceptedOf = (pass: Proposal) => pass.result.changes.filter((change) => pass.decisions[change.change_id] === 'accepted')

/** What a save means for a proposal: null when it held no accepted change (or names no version). */
function settleOnSave(
  pass: Proposal, placed: Placed, saved: SavedVersion,
): { decisions: Proposal['decisions']; mark: ToMark | null } | null {
  const accepted = acceptedOf(pass)
  const { version } = saved.document
  if (accepted.length === 0 || version === undefined) return null
  const kept = keptChanges(accepted, placed, saved.content)
  const keptIds = new Set(kept.map((change) => change.change_id))
  const acceptedIds = new Set(accepted.map((change) => change.change_id))
  const decisions = Object.fromEntries(Object.entries(pass.decisions).flatMap(([id, decision]): [string, Decision][] => {
    if (!acceptedIds.has(id)) return [[id, decision]]
    return keptIds.has(id) ? [[id, 'addressed']] : []
  }))
  const threadIds = threadIdsOf(kept)
  return {
    decisions,
    mark: threadIds.length === 0 ? null : { result: pass.result, documentId: saved.document.document_id, threadIds, version },
  }
}

/** The proposal holds changes taken into the draft and not saved yet. */
function holdsAcceptedChanges(proposal: Proposal | null): boolean {
  return proposal !== null && Object.values(proposal.decisions).includes('accepted')
}

/** Every accepted (not yet saved) decision dropped: those changes are pending again. */
function withoutAccepted(pass: Proposal): Proposal {
  const decisions = Object.fromEntries(Object.entries(pass.decisions).filter(([, decision]) => decision !== 'accepted'))
  return Object.keys(decisions).length === Object.keys(pass.decisions).length ? pass : { ...pass, decisions }
}

/**
 * The proposal after the canvas moved: a new save (`saved`) settles it (settleOnSave), a new generation (the draft
 * replaced without a save) puts what is still accepted back to pending. Both may come at once: the save first.
 */
function afterMoves(
  pass: Proposal, placed: Placed, saved: SavedVersion | null, replaced: boolean,
): { next: Proposal; mark: ToMark | null } {
  const settled = saved === null ? null : settleOnSave(pass, placed, saved)
  const kept = settled === null ? pass : { ...pass, decisions: settled.decisions }
  return { next: replaced ? withoutAccepted(kept) : kept, mark: settled?.mark ?? null }
}

/**
 * Follows the canvas's saves and generations (afterMoves) for the proposal being settled (the open one, or the
 * accepted changes a closed one left), settled while rendering; answers the threads to mark.
 */
function useCanvasMoves(
  tracked: Proposal | null, setTracked: (next: Proposal) => void, placed: Placed, setPlaced: (placed: Placed) => void,
  canvas: ReviseCanvas,
): ToMark | null {
  const { lastSaved, generation } = canvas
  const [seen, setSeen] = useState({ save: lastSaved, generation })
  const [toMark, setToMark] = useState<ToMark | null>(null)
  const replaced = generation !== seen.generation
  if (lastSaved === seen.save && !replaced) return toMark
  setSeen({ save: lastSaved, generation })
  if (tracked === null) return toMark
  const { next, mark } = afterMoves(tracked, placed, lastSaved === seen.save ? null : lastSaved, replaced)
  if (next !== tracked) setTracked(next)
  if (replaced) setPlaced(NOTHING_PLACED)
  if (mark !== null) setToMark(mark)
  return toMark
}

/** Undo of an applied pass: checks the head first, restores the version the pass read, clears its marks. */
function useUndo(
  { projectId, clearAddressed, canvas }: Pick<RevisePassArgs, 'projectId' | 'clearAddressed' | 'canvas'>,
  pass: RevisePass, setPass: (pass: RevisePass) => void,
) {
  const queryClient = useQueryClient()
  const restore = useCallback(async (applied: Applied, checked: boolean) => {
    const { result } = applied
    const version = result.applied_version
    if (version === null) return
    setPass({ kind: 'applied', result, undo: 'running' })
    try {
      if (checked) {
        // Restoring copies the version the pass read over the head: a version saved since would be reverted too.
        const head = (await projectsApi.getDocumentVersions(projectId, version.document_id)).find((v) => v.current)
        if (head !== undefined && head.version !== version.version) {
          setPass({ kind: 'applied', result, undo: 'confirm', newer: head.version })
          return
        }
      }
      const restored = await projectsApi.restoreDocumentVersion(
        projectId, version.document_id, result.base_document_id, crypto.randomUUID(),
      )
      // The revision no longer answers its threads: "Revise from comments" may take them again. A failure here
      // leaves them marked, as they were; the restore itself stands.
      if (result.addressed_thread_ids.length > 0) {
        await clearAddressed(restored?.document_id ?? version.document_id, result.addressed_thread_ids).catch(ignoreRejection)
      }
      // The project prefix also covers every versions list of this project (as History's restore).
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      if (restored !== null) canvas.selectDoc(restored)
      setPass({ kind: 'applied', result, undo: 'done' })
    } catch {
      setPass({ kind: 'applied', result, undo: 'failed' })
    }
  }, [projectId, clearAddressed, queryClient, canvas, setPass])
  const applied = pass.kind === 'applied' ? pass : null
  return {
    undo: () => (applied === null ? Promise.resolve() : restore(applied, true)),
    undoAnyway: () => (applied === null ? Promise.resolve() : restore(applied, false)),
    keepRevision: () => { if (applied !== null) setPass({ kind: 'applied', result: applied.result, undo: 'idle' }) },
  }
}

export function useRevisePass({ projectId, run, markAddressed, clearAddressed, draft, putDraft, canvas }: RevisePassArgs) {
  const [pass, setPass] = useState<RevisePass>({ kind: 'idle' })
  // Where each accepted change's new text went in the draft (a save counts it kept only while that one is there).
  const [placed, setPlaced] = useState<Placed>(NOTHING_PLACED)
  // Set by the first pass that answered: the rail then offers "Ask personas to review again".
  const [passed, setPassed] = useState(false)
  // A proposal closed while it held accepted, unsaved changes: the next save still marks their threads.
  const [pendingMarks, setPendingMarks] = useState<Proposal | null>(null)
  const tracked = pass.kind === 'proposal' ? pass : pendingMarks
  // A new pass would drop the accepted changes' marking: it waits for their save (or their discard).
  const holdsAccepted = holdsAcceptedChanges(tracked)

  const start = useCallback(async () => {
    if (holdsAccepted) return
    setPass({ kind: 'running' })
    setPlaced(NOTHING_PLACED)
    try {
      const result = await run()
      setPassed(true)
      if (result.outcome === 'proposal') setPass({ kind: 'proposal', result, decisions: {}, marked: null })
      // An applied pass names its version; without one nothing was written (read as recommendations).
      else if (result.outcome === 'applied' && result.applied_version !== null) {
        setPass({ kind: 'applied', result, undo: 'idle' })
        canvas.reloadLatest()
      } else setPass({ kind: 'recommendations', result })
    } catch (failure) {
      setPass({ kind: 'failed', message: serverReason(failure) ?? null })
    }
  }, [run, canvas, holdsAccepted])

  const decide = useCallback((changeIds: readonly string[], decision: Decision) => {
    setPass((current) => {
      if (current.kind !== 'proposal' || changeIds.length === 0) return current
      const decisions = { ...current.decisions }
      for (const id of changeIds) decisions[id] = decision
      return { ...current, decisions }
    })
  }, [])

  /** Accepts the given pending changes, in order, into the draft; one that is out of date stays pending. */
  const acceptChanges = useCallback((changeIds: readonly string[]) => {
    if (pass.kind !== 'proposal') return
    const wanted = pass.result.changes.filter((change) =>
      changeIds.includes(change.change_id) && pass.decisions[change.change_id] === undefined)
    // The changes accepted before are followed into the draft as it is now (typed on since, perhaps).
    const { now, taken } = wanted.reduce<{ now: Placed; taken: readonly string[] }>((acc, change) => {
      const next = placeChange(acc.now, change)
      return next === null ? acc : { now: next, taken: [...acc.taken, change.change_id] }
    }, { now: relocate(placed, draft()), taken: [] })
    if (taken.length === 0) return
    setPlaced(now)
    putDraft(now.draft)
    decide(taken, 'accepted')
  }, [pass, placed, draft, putDraft, decide])

  const pendingIds = pass.kind === 'proposal'
    ? pass.result.changes.filter((change) => pass.decisions[change.change_id] === undefined).map((change) => change.change_id)
    : []

  const setTracked = (next: Proposal) => {
    if (pass.kind === 'proposal') setPass(next)
    else setPendingMarks(holdsAcceptedChanges(next) ? next : null)
  }
  const toMark = useCanvasMoves(tracked, setTracked, placed, setPlaced, canvas)
  const marking = useRef<ToMark | null>(null)
  useEffect(() => {
    if (toMark === null || marking.current === toMark) return
    marking.current = toMark
    const { result, documentId, threadIds, version } = toMark
    // Said on the pass's own panel, while it is open (a closed one's marking happens all the same).
    const marked = (value: Proposal['marked']) =>
      setPass((current) => (current.kind === 'proposal' && current.result === result ? { ...current, marked: value } : current))
    markAddressed(documentId, threadIds).then(
      () => marked({ count: threadIds.length, version }),
      () => marked('failed'),
    )
  }, [toMark, markAddressed])

  // The canvas's next save is recorded as a revise (D4) when the text it sends still keeps an accepted change (the
  // same occurrence of its new text, see keptChanges): not once they are saved, discarded or edited away by hand.
  const keepsAccepted = useMemo(() => (holdsAccepted && tracked !== null
    ? (content: string) => keptChanges(acceptedOf(tracked), placed, content).length > 0
    : null), [holdsAccepted, tracked, placed])
  const { markRevised } = canvas
  useEffect(() => {
    markRevised(keepsAccepted)
    return () => markRevised(null)
  }, [markRevised, keepsAccepted])

  const close = useCallback(() => {
    if (pass.kind === 'proposal' && holdsAcceptedChanges(pass)) setPendingMarks(pass)
    setPass({ kind: 'idle' })
  }, [pass])

  const { undo, undoAnyway, keepRevision } = useUndo({ projectId, clearAddressed, canvas }, pass, setPass)

  return {
    pass,
    passed,
    /** Accepted changes not saved yet (the panel open or closed): a new pass waits for their save or discard. */
    holdsAccepted,
    start,
    accept: (changeId: string) => acceptChanges([changeId]),
    reject: (changeId: string) => decide([changeId], 'rejected'),
    acceptAll: () => acceptChanges(pendingIds),
    rejectAll: () => decide(pendingIds, 'rejected'),
    undo,
    undoAnyway,
    keepRevision,
    close,
  }
}

export type RevisePassControls = ReturnType<typeof useRevisePass>
