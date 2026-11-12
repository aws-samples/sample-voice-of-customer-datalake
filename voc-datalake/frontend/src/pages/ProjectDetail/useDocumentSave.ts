/**
 * @fileoverview Saving a document in place, with the no-clobber contract.
 *
 * An edit carries the revision the canvas loaded; a 409 means someone saved in
 * between (another tab, a teammate, the assistant). Instead of the second save
 * silently landing on top, the page shows the conflict and the user chooses:
 * - **Load the latest**: discard this draft and reload the canvas on the newest
 *   version (the same row, or the head of a PRD / PR/FAQ series);
 * - **Save mine anyway**: save again without the check. Nothing is lost either
 *   way — the other save stays in the document's version history.
 * Same pattern as the workflow editor's conflict banner (useWorkflowEditor).
 *
 * @module pages/ProjectDetail/useDocumentSave
 */
import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiErrorStatus, HTTP_CONFLICT } from '../../api/apiErrorStatus'
import { isVersionManagedDocument } from '../../api/documentLineage'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { ProjectDocument } from '../../api/types'
import { documentRevision, latestDocument } from './documentEdit'
import type { DocumentUpdate } from './useProjectData'

/** What the user wrote: the content, and the title (sent only for a research / custom document). */
export interface DocumentEdits {
  readonly title: string
  readonly content: string
}

interface DocumentSaveDeps {
  readonly projectId: string
  /** The stored document the edits were made on, read at save time (a save right after another is made on its result). */
  readonly stored: () => ProjectDocument
  /** Read at save time, so a save always sends the newest edits. */
  readonly edits: () => DocumentEdits
  /**
   * The canvas's generation, read when a save is sent and again when it is answered: a canvas that moved on
   * meanwhile (Discard, Load the latest, another version followed) is not the one the save was made on, so its
   * answer (the version, a 409 or an error) changes nothing there; the version it stored is in the history.
   */
  readonly generation: () => number
  /**
   * Asked of the text a save sends: it keeps changes accepted from "Revise from comments". A PR/FAQ / PRD save (the
   * only documents it revises) is then recorded as a revise (`edit_kind: 'revise'`, D4); absent or false, a plain edit.
   */
  readonly revised?: (content: string) => boolean
  readonly updateDoc: (variables: DocumentUpdate) => Promise<{ readonly document: ProjectDocument | null }>
  /** The version just saved (a PRD / PR/FAQ version has a new id), and the edits the save sent. */
  readonly onSaved: (saved: ProjectDocument, sent: DocumentEdits) => void
  /**
   * "Load the latest" found the newest copy (undefined: deleted meanwhile). Called only while the canvas is still
   * the one the load started on: same generation, same stored version (no save landed meanwhile) and the same
   * edits (nothing typed while the GET was on its way: that text stays, on the version it was typed on).
   */
  readonly onLoaded: (latest: ProjectDocument | undefined) => void
}

export interface DocumentSave {
  /** Save with the stale check: rejects on failure (the unsaved-changes guard waits for it). */
  readonly save: () => Promise<void>
  /** "Save mine anyway": save without the check (the other save stays in the version history). */
  readonly saveAnyway: () => Promise<void>
  /** Someone saved this document after the canvas loaded it (a 409): the caller offers the two ways out. */
  readonly conflict: boolean
  /** Refetch the project and hand the newest copy of the document to `onLoaded`. */
  readonly loadLatest: () => Promise<void>
  /** A "Load the latest" is on its way: the conflict's two ways out wait for it. */
  readonly loading: boolean
  /** The draft the conflict was about is gone (Discard): the banner, and its unchecked save, go with it. */
  readonly clearConflict: () => void
}

/**
 * The PUT's variables for `sent` over `document`: the revision check when `checked`; the title only for a research /
 * custom document (a PRD / PR/FAQ title is the series' own); `revised` only for a PRD / PR/FAQ (the only documents
 * "Revise from comments" works on).
 */
function updateOf(document: ProjectDocument, sent: DocumentEdits, checked: boolean, revised: boolean): DocumentUpdate {
  const versionManaged = isVersionManagedDocument(document)
  return {
    docId: document.document_id,
    ...(versionManaged ? {} : { title: sent.title }),
    content: sent.content,
    ...(checked ? { expectedRevision: documentRevision(document) } : {}),
    ...(versionManaged && revised ? { editKind: 'revise' as const } : {}),
  }
}

export function useDocumentSave({
  projectId, stored, edits, generation, revised, updateDoc, onSaved, onLoaded,
}: DocumentSaveDeps): DocumentSave {
  const queryClient = useQueryClient()
  const [conflict, setConflict] = useState(false)
  const [loading, setLoading] = useState(false)

  /** The newest stored copy of the document, read from the server (a failed refetch rejects). */
  const fetchLatest = useCallback(async () => {
    const project = await queryClient.query({
      queryKey: projectKey(projectId), queryFn: () => projectsApi.getProject(projectId), staleTime: 0,
    })
    return latestDocument(project.documents, stored())
  }, [projectId, queryClient, stored])

  /** Save the edits; an answer for a canvas that moved on since resolves and changes nothing (see `generation`). */
  const update = useCallback(async (checked: boolean) => {
    const sentOn = generation()
    const current = () => generation() === sentOn
    const sent = edits()
    const document = stored()
    try {
      const result = await updateDoc(updateOf(document, sent, checked, revised?.(sent.content) === true))
      if (!current()) return
      setConflict(false)
      // Every edit is a new version: show the one just saved (the edited one stays in Versions). An answer without
      // it still means the save landed: the stored copy is read back, never a revision made up here (none found:
      // the save rejects and the draft stays unsaved).
      const saved = result.document ?? await fetchLatest()
      if (!current()) return
      if (saved === undefined) throw new Error('The saved version could not be read back')
      onSaved(saved, sent)
    } catch (error) {
      if (!current()) return
      if (checked && apiErrorStatus(error) === HTTP_CONFLICT) setConflict(true)
      throw error
    }
  }, [edits, fetchLatest, generation, onSaved, revised, stored, updateDoc])

  const save = useCallback(() => update(true), [update])

  const saveAnyway = useCallback(() => update(false), [update])

  // A failed refetch rejects: the conflict stays on screen, and the draft with it. An answer for a canvas that
  // moved on (Discard, another version followed, a save landed) or that was typed on meanwhile changes nothing:
  // what is on the canvas now is newer than what the load was asked over.
  const loadLatest = useCallback(async () => {
    const startedOn = generation()
    const startedFrom = stored()
    const startedWith = edits()
    setLoading(true)
    try {
      const latest = await fetchLatest()
      const now = edits()
      if (generation() !== startedOn || stored() !== startedFrom) return
      if (now.content !== startedWith.content || now.title !== startedWith.title) return
      setConflict(false)
      onLoaded(latest)
    } finally {
      setLoading(false)
    }
  }, [edits, fetchLatest, generation, onLoaded, stored])

  const clearConflict = useCallback(() => setConflict(false), [])

  return { save, saveAnyway, loadLatest, loading, conflict, clearConflict }
}
