/**
 * @fileoverview What an editor can do to a document from its card in the documents list (DocumentCard): rename it,
 * and ask to delete it.
 *
 * Rename is the canvas's own (Document → Rename): ONE new version carrying the title alone, with the revision check
 * (useDocumentSave's `renameOf`, through the document PUT). The document open on its page is renamed through the page
 * instead (its canvas's `rename`, handed over as a {@link PageRename} while the page is open): that keeps its unsaved
 * text as the draft, waits for a save on its way and moves the page to the renamed version. Renamed behind the page's
 * back, the page would stay on the old version and its next save would meet the rename as a conflict. A 409 refetches
 * the project, so the list shows the newer version and a second try is made on it.
 *
 * Delete is the canvas's too: the page's confirmation (ProjectDetail), then the delete.
 *
 * @module pages/ProjectDetail/useDocumentCardActions
 */
import { useCallback, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiErrorStatus, HTTP_CONFLICT } from '../../api/apiErrorStatus'
import { projectKey } from '../../api/projectQueryKeys'
import { renameOf } from './useDocumentSave'
import { useUpdateDocument } from './useProjectData'
import type { DocumentCardActions } from './DocumentCard'
import type { ProjectDocument } from '../../api/types'

/** The open page's rename of its document (the canvas's `rename`), while the page is open. */
export interface PageRename {
  readonly documentId: string
  readonly rename: (title: string) => Promise<void>
}

interface CardActionsArgs {
  readonly projectId: string
  /** `canEditProject`: a viewer's cards have no actions (their menu has Open only). */
  readonly canEdit: boolean
  /** Asks first (the page's confirmation), then deletes. */
  readonly onDeleteDocument: (document: ProjectDocument) => void
  readonly isDeleting: boolean
}

/** The cards' actions, and where the open page hands over its rename (null when it closes). */
export function useDocumentCardActions({ projectId, canEdit, onDeleteDocument, isDeleting }: CardActionsArgs): {
  readonly actions: DocumentCardActions | undefined
  readonly onPageRename: (rename: PageRename | null) => void
} {
  const queryClient = useQueryClient()
  const { mutateAsync } = useUpdateDocument(projectId)
  const page = useRef<PageRename | null>(null)
  const onPageRename = useCallback((rename: PageRename | null) => { page.current = rename }, [])
  const rename = useCallback(async (document: ProjectDocument, title: string) => {
    const open = page.current
    if (open?.documentId === document.document_id) {
      await open.rename(title)
      return
    }
    try {
      await mutateAsync(renameOf(document, title))
    } catch (error) {
      if (apiErrorStatus(error) === HTTP_CONFLICT) void queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      throw error
    }
  }, [mutateAsync, projectId, queryClient])
  const actions = useMemo(
    () => (canEdit ? { rename, remove: onDeleteDocument, deleting: isDeleting } : undefined),
    [canEdit, rename, onDeleteDocument, isDeleting],
  )
  return { actions, onPageRename }
}
