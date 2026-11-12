/**
 * @fileoverview A document edited in place on its canvas: the draft, Save / Discard,
 * the stale-save conflict and the unsaved-changes guard.
 *
 * No edit mode and no autosave: a change marks the page "Unsaved changes", and Save
 * (the bar's primary button, or ⌘/Ctrl+S) writes ONE new version through the
 * document PUT, with the revision the canvas loaded and a fresh edit id (D1: never
 * overwrite; the server records the time and the version, D4). A 409 shows the
 * conflict (Load the latest / Save mine anyway). Leaving a dirty page — another
 * document (the page's guarded `onSelectDoc`), another tab, a route change, closing
 * the window — asks first (the one unsaved-changes guard every editor uses).
 *
 * The baseline is the stored version the canvas holds; it moves on a save, on
 * "Load the latest" and whenever the page selects another version (a restore, the
 * assistant's approved edit), and the editor is then reloaded on it.
 *
 * Every baseline belongs to a generation of the canvas. A save keeps it (the canvas
 * goes on from what it stored); Discard, a load (Load the latest, the approved edit's
 * reload) and following another version start a new one. A save is answered on the
 * generation it was sent from only: once the canvas moved on, its answer (the version,
 * a 409, an error) leaves the canvas, the selection and the conflict as they are (the
 * version it stored is in the history).
 *
 * @module components/DocumentCanvas/actions/useCanvasDocument
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { isVersionManagedDocument } from '../../../api/documentLineage'
import { useDocumentSave } from '../../../pages/ProjectDetail/useDocumentSave'
import { documentRevision } from '../../../pages/ProjectDetail/documentEdit'
import { canEditProject } from '../../../pages/ProjectDetail/projectAccess'
import { useUpdateDocument } from '../../../pages/ProjectDetail/useProjectData'
import { pathOrQueryChanged } from '../../UnsavedChangesGuard/pathOrQueryChanged'
import { useUnsavedChangesGuard } from '../../UnsavedChangesGuard/useUnsavedChangesGuard'
import { ignoreRejection } from '../../../lib/rejections'
import { noCleanup } from '../../../hooks/noCleanup'
import { isEditedElsewhere } from './documentKinds'
import { onlyFocusViewChanged } from '../page/focusView'
import type { CanvasEditorHandle } from '../editor/CanvasEditor'
import type { DocumentConflict } from './ConflictBanner'
import type { DocumentEdits } from '../../../pages/ProjectDetail/useDocumentSave'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'
import type { Location } from 'react-router-dom'

interface CanvasDocumentArgs {
  readonly project: Project
  readonly document: ProjectDocument
  /** The page's GUARDED selection (it asks first while this canvas is dirty). */
  readonly onSelectDoc: (doc: ProjectDocument) => void
}

export interface CanvasDocument {
  /**
   * The stored text the canvas is on (its baseline): the editable editor's `markdown`. It changes only when the
   * canvas moves to a version, never because the page selected a newer copy while the canvas holds changes.
   */
  readonly content: string
  readonly title: string
  readonly setTitle: (title: string) => void
  /** The editor's onChange. */
  readonly onChange: (markdown: string) => void
  readonly dirty: boolean
  readonly saving: boolean
  /** Rejects on failure (the conflict, or the error, stays on screen). A clean canvas saves nothing. */
  readonly save: () => Promise<void>
  readonly discard: () => void
  readonly conflict: DocumentConflict | null
  /** A research / custom title is edited in place; a PRD / PR/FAQ title is its series' own. */
  readonly titleEditable: boolean
  readonly handleRef: RefObject<CanvasEditorHandle | null>
  /** The caller may write this document on its canvas (editor of the project, not a prototype / decision). */
  readonly editable: boolean
  /** The page's guarded selection (Versions' restore selects the restored version through it). */
  readonly selectDoc: (doc: ProjectDocument) => void
  /** Reload the canvas on the newest stored version (after the assistant's approved edit); asks first while dirty. */
  readonly reloadLatest: () => void
  /** The unsaved-changes dialog: rendered once, by the action bar. */
  readonly guardDialog: ReactNode
  /** This canvas's last save, as it landed (a new object per save; null until one): "Revise from comments" reads it. */
  readonly lastSaved: SavedVersion | null
  /**
   * The canvas's generation (see the module's doc): it moves whenever the draft is replaced without a save (Discard,
   * Load the latest, an approved edit's reload, following another version); a save keeps it. "Revise from comments"
   * puts its accepted changes back to pending when it moves.
   */
  readonly generation: number
  /**
   * "Revise from comments" names its pass and says how to tell whether a saved text keeps changes the person accepted
   * from its proposal (null: it holds none): a PR/FAQ / PRD save whose text does names the pass (`revise_job_id`,
   * the server records a revise, D4); otherwise it is a plain edit.
   */
  readonly markRevised: (revised: RevisedBy | null) => void
  /** The server would not record the last save as a revise (400): its reason, and "Save as my own edit". */
  readonly reviseRefused: ReviseRefused | null
}

/** The accepted changes of a "Revise from comments" pass in the draft: the pass's job id, and whether a text keeps one. */
export interface RevisedBy {
  readonly jobId: string
  readonly keeps: (content: string) => boolean
}

/** A save the server would not record as a revise: nothing was saved, the draft stays. */
export interface ReviseRefused {
  /** The server's reason (null: it gave none). */
  readonly message: string | null
  /** The same save as a plain edit. Rejects on failure (what failed stays on screen). */
  readonly onSaveAsOwnEdit: () => Promise<void>
  readonly saving: boolean
}

/** A save of this canvas: the version it stored and the text it sent. */
interface SavedVersion {
  readonly document: ProjectDocument
  readonly content: string
}

interface Baseline {
  /** Which stored version this is (id and revision): a new one resets the canvas. */
  readonly key: string
  readonly content: string
  readonly title: string
  /** The stored version itself: the next save's revision check is against it. */
  readonly stored: ProjectDocument
  /** The canvas's generation (see the module's doc): a save is answered only on the one it was sent from. */
  readonly generation: number
  /** Followed from the selection (not moved to by this canvas): the editor is reloaded on it. */
  readonly reload?: boolean
  /** On a followed one: the baseline it replaced, kept if the editor still held a change made on it. */
  readonly left?: Baseline
}

function baselineOf(document: ProjectDocument, generation: number): Baseline {
  return {
    key: `${document.document_id}:${String(documentRevision(document) ?? 0)}`,
    content: document.content, title: document.title, stored: document, generation,
  }
}

/** `stored` is a later version than `selected` (a PRD / PR/FAQ series version, a research / custom revision). */
function isAhead(stored: ProjectDocument, selected: ProjectDocument): boolean {
  return (documentRevision(stored) ?? 0) > (documentRevision(selected) ?? 0)
}

/** ⌘/Ctrl+S, unless a dialog has the focus (its own form owns the keys). */
function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
  const focused = globalThis.document.activeElement
  return focused?.closest('[role="dialog"], [role="alertdialog"]') == null
}

function useSaveShortcut(active: boolean, save: () => Promise<void>): void {
  useEffect(() => {
    if (!active) return noCleanup
    const handler = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return
      // The browser's own "Save page" is never what a writer on this page means.
      event.preventDefault()
      save().catch(ignoreRejection)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, save])
}

/** What the canvas holds right now: the editor's text (read through the handle, which flushes its pending change). */
interface Held {
  readonly draft: string
  readonly title: string
  readonly baseline: Baseline
  /** The selected document's version (what the page shows as selected). */
  readonly selectedKey: string
}

/** A version this canvas moved to itself (saved, loaded), to select unless the canvas moved on since. */
interface ToSelect {
  readonly next: ProjectDocument
  readonly generation: number
}

function useCanvasDraft(document: ProjectDocument, editable: boolean, titleEditable: boolean) {
  const [baseline, setBaseline] = useState(() => baselineOf(document, 0))
  const [draft, setDraft] = useState(document.content)
  const [title, setTitle] = useState(document.title)
  const dirty = editable && (draft !== baseline.content || (titleEditable && title !== baseline.title))
  // Followed, the selected version starts a new generation of the canvas.
  const incoming = baselineOf(document, baseline.generation + 1)
  const [seen, setSeen] = useState(incoming.key)
  // A selected version skipped while the canvas was dirty: followed once the canvas is clean again (the change
  // typed away, say), while it is still the selection.
  const [skipped, setSkipped] = useState<string | null>(null)
  const follow = () => {
    setBaseline({ ...incoming, reload: true, left: baselineOf(baseline.stored, incoming.generation) })
    setDraft(incoming.content)
    setTitle(incoming.title)
    setSkipped(null)
  }
  if (incoming.key !== seen) {
    setSeen(incoming.key)
    // Another version is selected (a restore, an approved edit, a refetch), not the one this canvas moved to
    // itself: follow it while clean (state reset during render, not in an effect). While dirty the draft and
    // its baseline stay: the next save meets the newer version as a conflict, never a silent replace. The
    // reload checks the editor's own text first, and goes back to `left` if a change was typed in its pause.
    if (incoming.key === baseline.key) setSkipped(null)
    else if (dirty) setSkipped(incoming.key)
    else follow()
  } else if (skipped !== null && !dirty && skipped === incoming.key && incoming.key !== baseline.key) {
    // Never back to an older version: right after a save the baseline is the version just stored, ahead of the
    // selection until the page selects it.
    if (isAhead(baseline.stored, document)) setSkipped(null)
    else follow()
  }
  return { baseline, setBaseline, draft, setDraft, title, setTitle, dirty, selectedKey: incoming.key }
}

export function useCanvasDocument({ project, document, onSelectDoc }: CanvasDocumentArgs): CanvasDocument {
  const handleRef = useRef<CanvasEditorHandle | null>(null)
  const editable = canEditProject(project) && !isEditedElsewhere(document.document_type)
  const titleEditable = editable && !isVersionManagedDocument(document)
  const { baseline, setBaseline, draft, setDraft, title, setTitle, dirty, selectedKey } =
    useCanvasDraft(document, editable, titleEditable)

  // Read at save time, when a save is answered and by the route guard, which may run before the next render;
  // written at once by every change, and caught up with the render as it commits (a layout effect: no answer
  // can come in between and be judged on the generation the render just left).
  const held = useRef<Held>({ draft, title, baseline, selectedKey })
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
  /** The text on the canvas now: the editor's own (flushed), not the last debounced onChange. */
  const currentText = useCallback(() => handleRef.current?.getMarkdown() ?? held.current.draft, [])

  const toSelect = useRef<ToSelect | null>(null)
  const [lastSaved, setLastSaved] = useState<SavedVersion | null>(null)
  // The post-save selection of a version while the canvas still holds newer text: the guard lets it through.
  const [passing, setPassing] = useState(false)

  /**
   * Move the baseline to `next`. `sent`: a save of this generation landed as `next` with these edits, so what was
   * typed since stays as the draft. `null`: a load, which starts a new generation (any save still on its way is
   * answered on a canvas that moved on).
   */
  const adopt = useCallback((next: ProjectDocument, sent: DocumentEdits | null) => {
    const { baseline: base, title: heldTitle } = held.current
    const loaded = baselineOf(next, sent === null ? base.generation + 1 : base.generation)
    const handle = handleRef.current
    const text = currentText()
    const keepText = sent !== null && text !== sent.content
    const keepTitle = sent !== null && heldTitle !== sent.title
    const nextDraft = keepText ? text : loaded.content
    const nextTitle = keepTitle ? heldTitle : loaded.title
    const stillDirty = keepText || (titleEditable && keepTitle)
    held.current = { ...held.current, baseline: loaded, draft: nextDraft, title: nextTitle }
    dirtyRef.current = stillDirty
    setBaseline(loaded)
    setDraft(nextDraft)
    setTitle(nextTitle)
    if (!keepText && handle !== null && text !== loaded.content) handle.setMarkdown(loaded.content)
    toSelect.current = { next, generation: loaded.generation }
    if (stillDirty) setPassing(true)
  }, [currentText, setBaseline, setDraft, setTitle, titleEditable])

  // Another version reached the editable canvas while it was clean (a restore, an approved edit): reload the
  // editor on it. A read-only canvas shows the display text, not the stored one: its editor follows on its own.
  // The editor's text is read flushed: a change typed inside its pause (onChange not yet sent) is unsaved
  // work, so the canvas keeps it on the version it was typed on (`left`; its save meets the newer one as a 409).
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

  // A save that landed: the canvas moves on to it, and `lastSaved` says so (what the save sent, the version it made).
  const adoptSaved = useCallback((saved: ProjectDocument, sent: DocumentEdits) => {
    adopt(saved, sent)
    setLastSaved({ document: saved, content: sent.content })
  }, [adopt])
  const edits = useCallback(() => ({ title: held.current.title, content: currentText() }), [currentText])
  // Read through the ref: a save that waited for another is made on the version that one stored.
  const stored = useCallback(() => held.current.baseline.stored, [])
  const generation = useCallback(() => held.current.baseline.generation, [])
  // Asked of the text a save sends: set by "Revise from comments" while it holds accepted changes.
  const revisedRef = useRef<RevisedBy | null>(null)
  const markRevised = useCallback((revised: RevisedBy | null) => { revisedRef.current = revised }, [])
  // The pass the text holds accepted changes of (its job id), else null: a plain edit.
  const revised = useCallback((content: string) => {
    const by = revisedRef.current
    return by?.keeps(content) === true ? by.jobId : null
  }, [])
  const update = useUpdateDocument(project.project_id)
  const {
    save: saveChecked, saveAnyway: saveUnchecked, conflict, loadLatest, loading, clearConflict, reviseRefused, saveAsOwnEdit: savePlain,
  } = useDocumentSave({
    projectId: project.project_id, stored, edits, generation, revised, updateDoc: update.mutateAsync,
    onSaved: adoptSaved,
    onLoaded: (latest) => { if (latest !== undefined) adopt(latest, null) },
  })

  // One save at a time, whichever way it is asked for (the bar, the shortcut, the guard's Save, Save mine anyway).
  const inFlight = useRef<Promise<void> | null>(null)
  const fly = useCallback((send: () => Promise<void>): Promise<void> => {
    const running = send().finally(() => { inFlight.current = null })
    inFlight.current = running
    return running
  }, [])
  /** The canvas holds something the stored version does not (its text, or an editable title). */
  const holdsChanges = useCallback(() => {
    if (!editable) return false
    const { baseline: base, title: heldTitle } = held.current
    return currentText() !== base.content || (titleEditable && heldTitle !== base.title)
  }, [currentText, editable, titleEditable])
  const save = useCallback(function saveNow(): Promise<void> {
    // A save on its way: wait for it, then save what was typed since (a canvas it left clean saves nothing).
    if (inFlight.current !== null) return inFlight.current.then(saveNow)
    return holdsChanges() ? fly(saveChecked) : Promise.resolve()
  }, [fly, holdsChanges, saveChecked])
  // A second click of Save mine anyway, or one during a save, is that save: never a second unchecked version.
  // A clean canvas has nothing of its own to put over the newer version: it writes nothing (the stale loaded
  // text, unchecked, would replace a teammate's save), and the conflict it no longer holds goes away.
  // The same holds for "Save as my own edit" after a refused revise (the refusal goes with a draft no longer held).
  const saveOnce = useCallback((send: () => Promise<void>): Promise<void> => {
    if (inFlight.current !== null) return inFlight.current
    if (holdsChanges()) return fly(send)
    clearConflict()
    return Promise.resolve()
  }, [clearConflict, fly, holdsChanges])
  const saveAnyway = useCallback(() => saveOnce(saveUnchecked), [saveOnce, saveUnchecked])
  const saveAsOwnEdit = useCallback(() => saveOnce(savePlain), [saveOnce, savePlain])

  const discard = useCallback(() => {
    const { baseline: base, selectedKey: selected } = held.current
    // A newer version arrived while dirty (not followed): Discard follows it, as a clean canvas would have. Either
    // way the canvas moves on: a save still on its way is answered in the history, never on this canvas.
    const next = baselineOf(selected === base.key ? base.stored : document, base.generation + 1)
    // A 409's conflict was about the discarded draft: its banner (and its unchecked "Save mine anyway") goes.
    // The canvas lands on the newest version the page knows (the one it selected, as above); after a 409 that
    // has not reached the page it stays on the loaded one, and the next save meets the newer one as a 409 again.
    clearConflict()
    dirtyRef.current = false
    held.current = { ...held.current, baseline: next, draft: next.content, title: next.title }
    setBaseline(next)
    setDraft(next.content)
    setTitle(next.title)
    handleRef.current?.setMarkdown(next.content)
  }, [clearConflict, document, setBaseline, setDraft, setTitle])

  // Entering or leaving the focus view keeps this page and its draft: never a leave.
  const shouldBlock = useCallback(
    (current: Location, next: Location) =>
      dirtyRef.current && pathOrQueryChanged(current, next) && !onlyFocusViewChanged(current, next),
    [],
  )
  const guard = useUnsavedChangesGuard({
    dirty: dirty && !passing,
    // Proceeds only once the canvas holds nothing unsent (a save in flight is waited for, then what followed it).
    onSave: async () => { await save(); return !dirtyRef.current },
    onDiscard: discard,
    shouldBlock,
  })

  // Declared after the guard, so its record of `dirty` is current when the selection asks it. Skipped when the
  // canvas moved on meanwhile (the guard's Save, then the version the user picked, followed).
  useEffect(() => {
    const pending = toSelect.current
    if (pending === null || (dirty && !passing)) return
    toSelect.current = null
    if (pending.generation === baseline.generation) onSelectDoc(pending.next)
    if (passing) queueMicrotask(() => setPassing(false))
  })

  useSaveShortcut(editable, save)

  // A failed refetch keeps the canvas (and the conflict) as they are: the user can try again.
  const loadLatestOrStay = useCallback(() => loadLatest().catch(ignoreRejection), [loadLatest])
  const { requestLeave } = guard
  const reloadLatest = useCallback(() => {
    requestLeave(() => { void loadLatestOrStay() })
  }, [requestLeave, loadLatestOrStay])

  return {
    content: baseline.content,
    title,
    setTitle: changeTitle,
    onChange: changeDraft,
    dirty,
    saving: update.isPending,
    save,
    discard,
    conflict: conflict ? { onLoadLatest: loadLatestOrStay, onSaveAnyway: saveAnyway, saving: update.isPending, loading } : null,
    titleEditable,
    handleRef,
    editable,
    selectDoc: onSelectDoc,
    reloadLatest,
    guardDialog: guard.dialog,
    lastSaved,
    generation: baseline.generation,
    markRevised,
    reviseRefused: reviseRefused === null
      ? null
      : { message: reviseRefused.message, onSaveAsOwnEdit: saveAsOwnEdit, saving: update.isPending },
  }
}
