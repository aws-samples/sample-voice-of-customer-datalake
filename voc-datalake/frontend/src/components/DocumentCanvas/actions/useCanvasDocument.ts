/**
 * @fileoverview A project document edited in place on its canvas: the shared draft (components/Document/draft/
 * useDocumentDraft: the baseline, the generations, one save in flight, ⌘/Ctrl+S, the guard and the conflict with
 * Compare and merge) on the project's adapter (pages/ProjectDetail/documentAdapter.ts: who edits, the revision a save
 * is checked against, how it saves, renames and loads the latest, what counts as leaving). This file only names the
 * draft in the page's words (a project document selected, a Revise pass's mark, a refused revise).
 *
 * No edit mode and no autosave: a change marks the page "Unsaved changes", and Save (the bar's primary button, or
 * ⌘/Ctrl+S) writes ONE new version (D1, D4). A 409 shows the conflict. Leaving a dirty page asks first.
 *
 * @module components/DocumentCanvas/actions/useCanvasDocument
 */
import { useCallback, useMemo } from 'react'
import { useDocumentDraft } from '../../Document/draft/useDocumentDraft'
import { useProjectDocumentAdapter } from '../../../pages/ProjectDetail/documentAdapter'
import type { ReactNode, RefObject } from 'react'
import type { CanvasEditorHandle } from '../../Document/edit/editor/CanvasEditor'
import type { MergeProposal } from '../../Document/draft/useDocumentDraft'
import type { DocumentConflict } from '../../Document/types'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'

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
  /**
   * Rename the document (a research / custom one; a PRD / PR/FAQ title is its series' own): saved at once as ONE new
   * version carrying only the title, after a save on its way. Unsaved text stays the draft. Rejects on failure (the
   * title then stays unsaved, with the conflict when it was one).
   */
  readonly rename: (title: string) => Promise<void>
  /** The text being written (the editor's last change): the page counts its words. */
  readonly draft: string
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
   * The canvas's generation: it moves whenever the draft is replaced without a save (Discard, Load the latest, an
   * approved edit's reload, following another version, a merge); a save keeps it. "Revise from comments" puts its
   * accepted changes back to pending when it moves.
   */
  readonly generation: number
  /**
   * "Revise from comments" names its pass and says how to tell whether a saved text keeps changes the person accepted
   * from its proposal (null: it holds none): a PR/FAQ / PRD save whose text does names the pass (`revise_job_id`,
   * the server records a revise, D4); otherwise it is a plain edit.
   */
  readonly markRevised: (revised: RevisedBy | null) => void
  /** The server would not record the last save as a revise (400, code `revise_refused`): its reason, and "Save as my own edit". */
  readonly reviseRefused: ReviseRefused | null
  /** Compare and merge after a 409 (the bar's banner opens it): the latest version's changes against this draft. */
  readonly merge?: {
    readonly proposal: MergeProposal<ProjectDocument> | null
    readonly take: (changeIds: readonly string[]) => void
    readonly close: () => void
  }
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

export function useCanvasDocument({ project, document, onSelectDoc }: CanvasDocumentArgs): CanvasDocument {
  const adapter = useProjectDocumentAdapter(project, document)
  const state = useDocumentDraft<ProjectDocument, CanvasEditorHandle>(adapter, { stored: document, onSelect: onSelectDoc })
  const { lastSaved: saved, refused, setMark } = state
  // One object per save, as the draft's own (Revise follows it), and one stable mark setter.
  const lastSaved = useMemo(() => (saved === null ? null : { document: saved.stored, content: saved.content }), [saved])
  const markRevised = useCallback((revised: RevisedBy | null) => {
    setMark(revised === null ? null : { id: revised.jobId, keeps: revised.keeps })
  }, [setMark])
  return {
    ...state,
    selectDoc: onSelectDoc,
    lastSaved,
    markRevised,
    reviseRefused: refused === null ? null : { message: refused.message, onSaveAsOwnEdit: refused.onSaveUnmarked, saving: refused.saving },
  }
}
