/**
 * @fileoverview Saving the document editor, with the no-clobber contract.
 *
 * An edit carries the revision the editor loaded; a 409 means someone saved in
 * between (another tab, a teammate, the assistant). Instead of the second save
 * silently landing on top, the editor shows the conflict and the user chooses:
 * - **Load the latest**: discard this draft and reopen the editor on the newest
 *   version (the same row, or the head of a PRD / PR-FAQ series);
 * - **Save mine anyway**: save again without the check. Nothing is lost either
 *   way — the other save stays in the document's version history.
 * Same pattern as the workflow editor's conflict banner (useWorkflowEditor).
 *
 * @module pages/ProjectDetail/useDocumentSave
 */
import { useCallback, useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { isVersionManagedDocument } from '../../api/documentLineage'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { ProjectDocument } from '../../api/types'
import { documentRevision, latestDocument } from './documentEdit'
import type { DocumentConflict } from './DocumentModal'
import type { useDocModalState } from './useModalState'

const HTTP_CONFLICT = 409

interface UpdateVariables {
  docId: string
  title?: string
  content: string
  expectedRevision?: number
}

interface DocumentSaveDeps {
  /** The page's route id (undefined only before the route resolved). */
  readonly projectId: string | undefined
  readonly queryClient: QueryClient
  readonly docModal: ReturnType<typeof useDocModalState>
  readonly updateDoc: (variables: UpdateVariables) => Promise<unknown>
  readonly createDoc: (variables: { title: string; content: string }) => Promise<unknown>
}

export interface DocumentSave {
  /** The editor's Save: rejects on failure (the unsaved-changes guard waits for it). */
  readonly save: () => Promise<void>
  /** Set when someone saved this document after the editor loaded it (a 409): its two ways out. */
  readonly conflict: DocumentConflict | null
}

export function useDocumentSave({ projectId = '', queryClient, docModal, updateDoc, createDoc }: DocumentSaveDeps): DocumentSave {
  const [conflict, setConflict] = useState(false)
  const { editingDoc } = docModal

  const update = useCallback(async (doc: ProjectDocument, checked: boolean) => {
    await updateDoc({
      docId: doc.document_id,
      // A PRD / PR-FAQ title is the series' own; only research / custom titles change.
      ...(isVersionManagedDocument(doc) ? {} : { title: docModal.newDocTitle }),
      content: docModal.newDocContent,
      ...(checked ? { expectedRevision: documentRevision(doc) } : {}),
    })
    setConflict(false)
    docModal.resetAfterSave()
  }, [docModal, updateDoc])

  const save = useCallback(async () => {
    if (editingDoc === null) {
      await createDoc({ title: docModal.newDocTitle, content: docModal.newDocContent })
      docModal.setShowDocModal(false)
      return
    }
    try {
      await update(editingDoc, true)
    } catch (error) {
      if (apiErrorStatus(error) === HTTP_CONFLICT) setConflict(true)
      throw error
    }
  }, [createDoc, docModal, editingDoc, update])

  const saveAnyway = useCallback(async () => {
    if (editingDoc !== null) await update(editingDoc, false)
  }, [editingDoc, update])

  const loadLatest = useCallback(async () => {
    if (editingDoc === null) return
    const fresh = await queryClient.fetchQuery({
      queryKey: projectKey(projectId), queryFn: () => projectsApi.getProject(projectId), staleTime: 0,
    })
    setConflict(false)
    const latest = latestDocument(fresh.documents, editingDoc)
    if (latest === undefined) docModal.closeModal()
    else docModal.openEditModal(latest)
  }, [docModal, editingDoc, projectId, queryClient])

  return { save, conflict: conflict ? { onLoadLatest: loadLatest, onSaveAnyway: saveAnyway } : null }
}
