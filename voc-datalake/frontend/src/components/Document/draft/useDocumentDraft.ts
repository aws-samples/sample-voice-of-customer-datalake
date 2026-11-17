/**
 * @fileoverview A document edited in place: the draft, Save / Discard, the stale-save conflict (with Compare and
 * merge) and the unsaved-changes guard, for any feature's document through its adapter (types.ts DocumentAdapter).
 *
 * No edit mode and no autosave: a change marks the document "Unsaved changes", and Save (or ⌘/Ctrl+S) writes ONE new
 * version through the adapter, checked against the version the draft was made on (D1: never overwrite). A conflict
 * shows its ways out (Compare and merge, Load the latest, Save mine anyway). Leaving a dirty document (another one,
 * a route change, closing the window) asks first; an address change the adapter says keeps this document on screen
 * (`isSameDocument`: its full-screen view, an older version) is never a leave.
 *
 * The baseline is the stored version the draft holds; it moves on a save, on "Load the latest", on a merge and
 * whenever the feature selects another version (a restore, an approved edit), and the editor is then reloaded on it.
 * Every baseline belongs to a generation of the draft: a save keeps it (the draft goes on from what it stored);
 * Discard, a load, a merge and following another version start a new one. A save is answered on the generation it
 * was sent from only: once the draft moved on, its answer leaves the draft, the selection and the conflict as they
 * are (the version it stored is in the history).
 *
 * @module components/Document/draft/useDocumentDraft
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { pathOrQueryChanged } from '../../UnsavedChangesGuard/pathOrQueryChanged'
import { useUnsavedChangesGuard } from '../../UnsavedChangesGuard/useUnsavedChangesGuard'
import { ignoreRejection } from '../../../lib/rejections'
import { mergeChanges, takeChanges } from '../diff/merge'
import { useSaveFlow } from './useSaveFlow'
import { useSaveShortcut } from './saveShortcut'
import { useFollowedVersion } from './followVersion'
import type { ReactNode, RefObject } from 'react'
import type { Location } from 'react-router-dom'
import type { MergeChange } from '../diff/merge'
import type { DocumentAdapter, DocumentConflict, DocumentDraft, DraftEditor, StoredDocument } from '../types'
import type { Baseline } from './followVersion'

/** A mark the next saves carry while the text keeps what it marks (Projects: a Revise pass's accepted changes). */
export interface SaveMark {
  readonly id: string
  readonly keeps: (content: string) => boolean
}

/** Compare and merge: the latest version, and its changes judged against the draft. */
export interface MergeProposal<S extends StoredDocument> {
  readonly latest: S
  /** Null: too large to compare block by block (only the other two ways out are left). */
  readonly changes: readonly MergeChange[] | null
}

export interface DocumentDraftState<S extends StoredDocument, H extends DraftEditor> {
  /** The stored text the draft is on (its baseline): the editable editor's `markdown`. */
  readonly content: string
  readonly title: string
  readonly setTitle: (title: string) => void
  /** Rename in place (one new version carrying only the title, after a save on its way). Rejects on failure. */
  readonly rename: (title: string) => Promise<void>
  /** The text being written (the editor's last change). */
  readonly draft: string
  readonly onChange: (markdown: string) => void
  readonly dirty: boolean
  readonly saving: boolean
  /** Rejects on failure (the conflict, or the error, stays on screen). A clean draft saves nothing. */
  readonly save: () => Promise<void>
  readonly discard: () => void
  readonly conflict: DocumentConflict | null
  readonly titleEditable: boolean
  readonly handleRef: RefObject<H | null>
  readonly editable: boolean
  /** Reload the draft on the newest stored version; asks first while dirty. */
  readonly reloadLatest: () => void
  /** The unsaved-changes dialog: rendered once, by the surface's bar. */
  readonly guardDialog: ReactNode
  /** The last save, as it landed (a new object per save; null until one). */
  readonly lastSaved: { readonly stored: S; readonly content: string } | null
  /** The draft's generation (see the module's doc). */
  readonly generation: number
  /** Set (or clear) the mark the next saves carry. */
  readonly setMark: (mark: SaveMark | null) => void
  /** The server would not record the last save with its mark: its reason, and the same save unmarked. */
  readonly refused: { readonly message: string | null; readonly onSaveUnmarked: () => Promise<void>; readonly saving: boolean } | null
  /** The open Compare and merge (null: none), and how to take it or leave it. */
  readonly merge: {
    readonly proposal: MergeProposal<S> | null
    readonly take: (changeIds: readonly string[]) => void
    readonly close: () => void
  }
}

interface DraftArgs<S extends StoredDocument> {
  /** The version the feature selected (a newer copy may arrive while the draft holds changes: see followVersion). */
  readonly stored: S
  /** The feature's GUARDED selection (it asks first while the draft is dirty). */
  readonly onSelect: (stored: S) => void
}

/** What the draft holds right now: the editor's text (read through the handle, which flushes its pending change). */
interface Held<S extends StoredDocument> {
  readonly draft: string
  readonly title: string
  readonly baseline: Baseline<S>
  /** The selected version's key (what the feature shows as selected). */
  readonly selectedKey: string
}

/** A version this draft moved to itself (saved, loaded, merged), to select unless the draft moved on since. */
interface ToSelect<S> { readonly next: S; readonly generation: number }

/**
 * What a move to `loaded` keeps of the draft (`adopt`'s rule). A merge (`kept`) keeps its text and the title held,
 * dirty unless they equal the version's. A save that landed (`sent`) keeps what was typed since it was sent. A load
 * keeps nothing.
 */
function draftAfter(
  loaded: { readonly content: string; readonly title: string }, held: { readonly text: string; readonly title: string },
  sent: DocumentDraft | null, kept: string | null, titleEditable: boolean,
): { readonly draft: string; readonly title: string; readonly dirty: boolean } {
  if (kept !== null) {
    return { draft: kept, title: held.title, dirty: kept !== loaded.content || (titleEditable && held.title !== loaded.title) }
  }
  const keepText = sent !== null && held.text !== sent.content
  const keepTitle = sent !== null && held.title !== sent.title
  return { draft: keepText ? held.text : loaded.content, title: keepTitle ? held.title : loaded.title,
    dirty: keepText || (titleEditable && keepTitle) }
}

/** One state machine (the module's doc); its parts that stand alone are followVersion, saveShortcut and useSaveFlow. */
export function useDocumentDraft<S extends StoredDocument, H extends DraftEditor>(
  adapter: DocumentAdapter<S>, { stored: document, onSelect }: DraftArgs<S>,
): DocumentDraftState<S, H> {
  const handleRef = useRef<H | null>(null)
  const editable = adapter.permissions.edit === true
  const titleEditable = editable && adapter.rename !== undefined
  const { baseline, setBaseline, draft, setDraft, title, setTitle, dirty, selectedKey, baselineOf } =
    useFollowedVersion(adapter, document, editable, titleEditable)

  // Read at save time, when a save is answered and by the route guard, which may run before the next render; written
  // at once by every change, and caught up with the render as it commits.
  const held = useRef<Held<S>>({ draft, title, baseline, selectedKey })
  const dirtyRef = useRef(dirty)
  useLayoutEffect(() => {
    held.current = { draft, title, baseline, selectedKey }
    dirtyRef.current = dirty
  })
  const changeDraft = useCallback((markdown: string) => {
    held.current = { ...held.current, draft: markdown }
    setDraft(markdown)
  }, [setDraft])
  const changeTitle = useCallback((next: string) => {
    held.current = { ...held.current, title: next }
    setTitle(next)
  }, [setTitle])
  /** The text in the draft now: the editor's own (flushed), not the last debounced onChange. */
  const currentText = useCallback(() => handleRef.current?.getMarkdown() ?? held.current.draft, [])

  const toSelect = useRef<ToSelect<S> | null>(null)
  const [lastSaved, setLastSaved] = useState<{ readonly stored: S; readonly content: string } | null>(null)
  // The post-save selection of a version while the draft still holds newer text: the guard lets it through.
  const [passing, setPassing] = useState(false)

  /**
   * Move the baseline to `next`. `sent`: a save of this generation landed as `next` with these edits, so what was
   * typed since stays as the draft. `kept`: a merge, whose text is the draft on top of `next`. Otherwise a load,
   * which starts a new generation (any save still on its way is answered on a draft that moved on).
   */
  const adopt = useCallback((next: S, sent: DocumentDraft | null, kept: string | null = null) => {
    const { baseline: base, title: heldTitle } = held.current
    const loaded = baselineOf(next, sent === null ? base.generation + 1 : base.generation)
    const handle = handleRef.current
    const text = currentText()
    const { draft: nextDraft, title: nextTitle, dirty: stillDirty } = draftAfter(loaded, { text, title: heldTitle }, sent,
      kept, titleEditable)
    held.current = { ...held.current, baseline: loaded, draft: nextDraft, title: nextTitle }
    dirtyRef.current = stillDirty
    setBaseline(loaded)
    setDraft(nextDraft)
    setTitle(nextTitle)
    if (handle !== null && text !== nextDraft) handle.setMarkdown(nextDraft)
    toSelect.current = { next, generation: loaded.generation }
    if (stillDirty) setPassing(true)
  }, [baselineOf, currentText, setBaseline, setDraft, setTitle, titleEditable])

  // Another version reached the editable draft while it was clean (a restore, an approved edit): reload the editor
  // on it. The editor's text is read flushed: a change typed inside its pause (onChange not yet sent) is unsaved
  // work, so the draft keeps it on the version it was typed on (`left`; its save meets the newer one as a conflict).
  useEffect(() => {
    const handle = handleRef.current
    if (!editable || baseline.reload !== true || handle === null) return
    const text = handle.getMarkdown()
    const { left } = baseline
    // The editor may already show the followed version (it reloads itself while it holds nothing unsent).
    if (left !== undefined && text !== baseline.content && text !== left.content) {
      held.current = { ...held.current, baseline: left, draft: text, title: left.title }
      dirtyRef.current = true
      setBaseline(left)
      setDraft(text)
      setTitle(left.title)
      return
    }
    if (text !== baseline.content) handle.setMarkdown(baseline.content)
  }, [baseline, editable, setBaseline, setDraft, setTitle])

  const adoptSaved = useCallback((saved: S, sent: DocumentDraft) => {
    adopt(saved, sent)
    setLastSaved({ stored: saved, content: sent.content })
  }, [adopt])
  const edits = useCallback(() => ({ title: held.current.title, content: currentText() }), [currentText])
  // Read through the ref: a save that waited for another is made on the version that one stored.
  const storedNow = useCallback(() => held.current.baseline.stored, [])
  const generationNow = useCallback(() => held.current.baseline.generation, [])
  const markRef = useRef<SaveMark | null>(null)
  const setMark = useCallback((mark: SaveMark | null) => { markRef.current = mark }, [])
  const markOf = useCallback((content: string) => {
    const mark = markRef.current
    return mark?.keeps(content) === true ? mark.id : null
  }, [])
  const flow = useSaveFlow({
    adapter, stored: storedNow, edits, generation: generationNow, markOf, onSaved: adoptSaved,
    onLoaded: (latest) => { if (latest !== undefined) adopt(latest, null) },
  })
  const { clearConflict } = flow

  // One save at a time, whichever way it is asked for (the bar, the shortcut, the guard's Save, Save mine anyway).
  const inFlight = useRef<Promise<void> | null>(null)
  const fly = useCallback((send: () => Promise<void>): Promise<void> => {
    const running = send().finally(() => { inFlight.current = null })
    inFlight.current = running
    return running
  }, [])
  /** The draft holds something the stored version does not (its text, or an editable title). */
  const holdsChanges = useCallback(() => {
    if (!editable) return false
    const { baseline: base, title: heldTitle } = held.current
    return currentText() !== base.content || (titleEditable && heldTitle !== base.title)
  }, [currentText, editable, titleEditable])
  const { save: saveChecked, saveAnyway: saveUnchecked, saveUnmarked: sendUnmarked, rename: renameStored } = flow
  const save = useCallback(function saveNow(): Promise<void> {
    // A save on its way: wait for it, then save what was typed since (a draft it left clean saves nothing).
    if (inFlight.current !== null) return inFlight.current.then(saveNow)
    return holdsChanges() ? fly(saveChecked) : Promise.resolve()
  }, [fly, holdsChanges, saveChecked])
  // A second click of Save mine anyway, or one during a save, is that save: never a second unchecked version. A clean
  // draft has nothing of its own to put over the newer version: it writes nothing, and the conflict goes away. The
  // same holds for "Save as my own edit" after a refused save.
  const saveOnce = useCallback((send: () => Promise<void>): Promise<void> => {
    if (inFlight.current !== null) return inFlight.current
    if (holdsChanges()) return fly(send)
    clearConflict()
    return Promise.resolve()
  }, [clearConflict, fly, holdsChanges])
  const saveAnyway = useCallback(() => saveOnce(saveUnchecked), [saveOnce, saveUnchecked])
  const saveUnmarked = useCallback(() => saveOnce(sendUnmarked), [saveOnce, sendUnmarked])
  const rename = useCallback(function renameNow(next: string): Promise<void> {
    if (inFlight.current !== null) return inFlight.current.then(() => renameNow(next))
    if (!titleEditable) return Promise.resolve()
    changeTitle(next)
    return next === held.current.baseline.title ? Promise.resolve() : fly(() => renameStored(next))
  }, [changeTitle, fly, renameStored, titleEditable])

  const discard = useCallback(() => {
    const { baseline: base, selectedKey: selected } = held.current
    // A newer version arrived while dirty (not followed): Discard follows it, as a clean draft would have.
    const next = baselineOf(selected === base.key ? base.stored : document, base.generation + 1)
    clearConflict()
    dirtyRef.current = false
    held.current = { ...held.current, baseline: next, draft: next.content, title: next.title }
    setBaseline(next)
    setDraft(next.content)
    setTitle(next.title)
    handleRef.current?.setMarkdown(next.content)
  }, [baselineOf, clearConflict, document, setBaseline, setDraft, setTitle])

  const { isSameDocument } = adapter
  const shouldBlock = useCallback(
    (current: Location, next: Location) =>
      dirtyRef.current && pathOrQueryChanged(current, next) && isSameDocument?.(current, next) !== true,
    [isSameDocument],
  )
  const guard = useUnsavedChangesGuard({
    dirty: dirty && !passing,
    // Proceeds only once the draft holds nothing unsent (a save in flight is waited for, then what followed it).
    onSave: async () => { await save(); return !dirtyRef.current },
    onDiscard: discard,
    shouldBlock,
  })

  // Declared after the guard, so its record of `dirty` is current when the selection asks it. Skipped when the
  // draft moved on meanwhile (the guard's Save, then the version the user picked, followed).
  useEffect(() => {
    const pending = toSelect.current
    if (pending === null || (dirty && !passing)) return
    toSelect.current = null
    if (pending.generation === baseline.generation) onSelect(pending.next)
    if (passing) queueMicrotask(() => setPassing(false))
  })

  useSaveShortcut(editable, save)

  const merge = useMerge(flow.latest, held, currentText, adopt, clearConflict)

  // A failed read keeps the draft (and the conflict) as they are: the user can try again.
  const { loadLatest } = flow
  const loadLatestOrStay = useCallback(() => loadLatest().catch(ignoreRejection), [loadLatest])
  const { requestLeave } = guard
  const reloadLatest = useCallback(() => {
    requestLeave(() => { void loadLatestOrStay() })
  }, [requestLeave, loadLatestOrStay])

  return {
    content: baseline.content, title, setTitle: changeTitle, rename, draft, onChange: changeDraft, dirty,
    saving: flow.saving, save, discard,
    conflict: flow.conflict ? {
      onLoadLatest: loadLatestOrStay, onSaveAnyway: saveAnyway, onCompare: merge.open,
      saving: flow.saving, loading: flow.loading || merge.loading,
    } : null,
    titleEditable, handleRef, editable, reloadLatest, guardDialog: guard.dialog, lastSaved,
    generation: baseline.generation, setMark,
    refused: flow.refused === null ? null : { message: flow.refused.message, onSaveUnmarked: saveUnmarked, saving: flow.saving },
    merge: { proposal: merge.proposal, take: merge.take, close: merge.close },
  }
}

/** Compare and merge: read the latest version, judge its changes against the draft, take the chosen ones. */
function useMerge<S extends StoredDocument>(
  latest: () => Promise<S | undefined>, held: RefObject<Held<S>>, currentText: () => string,
  adopt: (next: S, sent: DocumentDraft | null, kept: string | null) => void, clearConflict: () => void,
) {
  const [proposal, setProposal] = useState<MergeProposal<S> | null>(null)
  const [loading, setLoading] = useState(false)
  const open = useCallback(async () => {
    setLoading(true)
    try {
      const found = await latest()
      if (found === undefined) return
      const base = held.current.baseline.content
      setProposal({ latest: found, changes: mergeChanges(base, found.content, currentText()) })
    } finally {
      setLoading(false)
    }
  }, [currentText, held, latest])
  const take = useCallback((changeIds: readonly string[]) => {
    if (proposal === null) return
    const chosen = (proposal.changes ?? []).filter((change) => changeIds.includes(change.id))
    const { text } = takeChanges(currentText(), chosen)
    clearConflict()
    setProposal(null)
    // The draft now stands on the latest version: its next save is checked against that one.
    adopt(proposal.latest, null, text)
  }, [adopt, clearConflict, currentText, proposal])
  const close = useCallback(() => setProposal(null), [])
  return { proposal, loading, open, take, close }
}
