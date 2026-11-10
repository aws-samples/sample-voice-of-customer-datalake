/**
 * @fileoverview The Documents tab's selected document, deep-linkable as `?doc=<id>`.
 *
 * Selecting a document writes `?doc=`, and a `?doc=` from outside — a reload, a
 * pasted link, the Decisions card's "PR/FAQ ready" link — selects that document
 * once the project's documents are loaded.
 *
 * @module pages/ProjectDetail/useDocumentSelection
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ProjectDocument } from '../../api/types'

/** The query parameter naming the selected document. */
const DOC_PARAM = 'doc'

/** The path that opens one document of a project on its Documents tab. */
export function projectDocumentPath(projectId: string, documentId: string): string {
  const query = new URLSearchParams({ tab: 'documents', [DOC_PARAM]: documentId })
  return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`
}

function withDocParam(prev: URLSearchParams, documentId: string | null): URLSearchParams {
  const next = new URLSearchParams(prev)
  if (documentId === null) next.delete(DOC_PARAM)
  else next.set(DOC_PARAM, documentId)
  return next
}

function resolveSelection(
  docParam: string | null, held: ProjectDocument | null, documents: readonly ProjectDocument[] | undefined,
): ProjectDocument | null {
  if (docParam === null) return null
  if (held?.document_id === docParam) return held
  return documents?.find((d) => d.document_id === docParam) ?? null
}

/**
 * The selected document, DERIVED from `?doc=` on every render rather than copied
 * into state by an effect: the held object wins only while it is the document the
 * address names (an edit shows the version just saved before the refetch lands);
 * any other `?doc=` — a reload, a pasted link — resolves against the documents.
 */
export function useDocumentSelection(documents: readonly ProjectDocument[] | undefined) {
  const [held, setHeld] = useState<ProjectDocument | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const docParam = searchParams.get(DOC_PARAM)

  const selectedDoc = resolveSelection(docParam, held, documents)

  const setSelectedDoc = useCallback((doc: ProjectDocument | null) => {
    setHeld(doc)
    setSearchParams((prev) => withDocParam(prev, doc?.document_id ?? null), { replace: true })
  }, [setSearchParams])

  // A link to a document this project does not have: drop it once the documents
  // are known, so the address bar and the (empty) selection agree — the same rule
  // an unknown `?tab=` follows.
  const dangling = docParam !== null && documents !== undefined && selectedDoc === null
  useEffect(() => {
    if (dangling) setSearchParams((prev) => withDocParam(prev, null), { replace: true })
  }, [dangling, setSearchParams])

  return { selectedDoc, setSelectedDoc }
}
