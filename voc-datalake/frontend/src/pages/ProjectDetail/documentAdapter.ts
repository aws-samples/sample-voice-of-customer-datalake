/**
 * @fileoverview A project document as the shared document component's first adapter (components/Document/types.ts
 * DocumentAdapter): the project's rules, kept here and nowhere in the component.
 *
 * - Who edits: an editor of the project, on a document edited on its canvas (a decision is edited in its own tab:
 *   `editedElsewhere`; anyone else reads: `viewer`).
 * - Which revision a save is checked against: a PRD / PR/FAQ's series `version`, a research / custom document's
 *   `revision` (documentEdit `documentRevision`).
 * - How it saves: `PUT /projects/{id}/documents/{doc}` with `expected_revision` (none for "Save mine anyway"), a
 *   fresh `edit_id`, and for a PRD / PR/FAQ the Revise pass its text keeps (`revise_job_id`, the save's mark; refused
 *   with a 400 `revise_refused`, nothing saved). Only a research / custom document sends its title (a PRD / PR/FAQ
 *   title is its series' own) and is renamed in place.
 * - Load the latest: the project read again, and the newest copy of the document (the same row, or the head of its
 *   series: an edit there is a new row).
 * - Leaving: entering or leaving the focus view, or reading an older version, keeps the page and its draft.
 *
 * @module pages/ProjectDetail/documentAdapter
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { isVersionManagedDocument } from '../../api/documentLineage'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { apiErrorCode, serverReason } from '../../lib/errors'
import { isEditedElsewhere, isRenamedInPlace } from '../../components/DocumentCanvas/actions/documentKinds'
import { documentRevision, latestDocument } from './documentEdit'
import { canEditProject } from './projectAccess'
import { useUpdateDocument } from './useProjectData'
import { onlyDocumentViewChanged } from './useProjectPlace'
import type { DocumentAdapter, DocumentDraft, SaveOptions } from '../../components/Document/types'
import type { Project } from '../../api/projectTypes'
import type { ProjectDocument } from '../../api/types'
import type { DocumentUpdate } from './useProjectData'

/** 400: the server refused the body; with `REVISE_REFUSED_CODE`, the pass a revise save names. */
const HTTP_BAD_REQUEST = 400
/** The `code` of the server's refusal to record a save as a revise; any other 400 is the save's normal error. */
const REVISE_REFUSED_CODE = 'revise_refused'

/**
 * The PUT's variables for `sent` over `document`: the revision check when `checked`; the title only for a research /
 * custom document; the pass (`mark`) only for a PRD / PR/FAQ (the only documents "Revise from comments" works on).
 */
function updateOf(document: ProjectDocument, sent: DocumentDraft, { checked, mark }: SaveOptions): DocumentUpdate {
  const versionManaged = isVersionManagedDocument(document)
  return {
    docId: document.document_id,
    ...(versionManaged ? {} : { title: sent.title }),
    content: sent.content,
    ...(checked ? { expectedRevision: documentRevision(document) } : {}),
    ...(versionManaged && mark !== null ? { reviseJobId: mark } : {}),
  }
}

/** A rename's PUT: the title alone, checked against the revision held (the canvas's, or the list card's: DocumentCard). */
export function renameOf(document: ProjectDocument, title: string): DocumentUpdate {
  return { docId: document.document_id, title, expectedRevision: documentRevision(document) }
}

/** A save the server would not record as a revise (400 `revise_refused`): its reason. */
function refusalOf(error: unknown): { readonly message: string | null } | null {
  return apiErrorStatus(error) === HTTP_BAD_REQUEST && apiErrorCode(error) === REVISE_REFUSED_CODE
    ? { message: serverReason(error) }
    : null
}

/** The project's document, as the document component's adapter (memoized on what its rules read). */
export function useProjectDocumentAdapter(project: Project, document: ProjectDocument): DocumentAdapter<ProjectDocument> {
  const queryClient = useQueryClient()
  const { mutateAsync } = useUpdateDocument(project.project_id)
  const projectId = project.project_id
  const editable = canEditProject(project) && !isEditedElsewhere(document.document_type)
  const viewerReason = isEditedElsewhere(document.document_type) ? 'editedElsewhere' as const : 'viewer' as const
  const renamed = isRenamedInPlace(document)
  return useMemo((): DocumentAdapter<ProjectDocument> => {
    const write = async (variables: DocumentUpdate) => (await mutateAsync(variables)).document
    return {
      id: `project:${projectId}`,
      contentType: 'markdown',
      permissions: { edit: editable ? true : viewerReason },
      versionOf: (stored) => {
        const revision = documentRevision(stored)
        return { token: `${stored.document_id}:${String(revision ?? 0)}`, number: revision }
      },
      load: async (stored) => {
        const fresh = await queryClient.query({
          queryKey: projectKey(projectId), queryFn: () => projectsApi.getProject(projectId), staleTime: 0,
        })
        return latestDocument(fresh.documents, stored)
      },
      save: (draft, on, options) => write(updateOf(on, draft, options)),
      ...(renamed ? { rename: (title: string, on: ProjectDocument) => write(renameOf(on, title)) } : {}),
      refusalOf,
      isSameDocument: onlyDocumentViewChanged,
    }
  }, [editable, mutateAsync, projectId, queryClient, renamed, viewerReason])
}
