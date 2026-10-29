/**
 * @fileoverview The project-detail cache entry after a decision write.
 *
 * A save answers the saved document (`{success, document}`), and a delete knows which
 * document went. Both are written into the `projectKey` entry the Decisions tab renders
 * from at once, then the project is refetched in the background. The stale card after an
 * edit was the header's read-only `skipToken` observer of this entry (fixed in
 * `hooks/useCachedQueryData.ts`): with it, invalidating the entry refetched nothing, so
 * the card kept the old values and the old `revision` (a second edit was a 409). Writing
 * the answer also keeps the card right while a refetch is slow or cancelled by another
 * invalidation of the same key (a job finishing, the prototype-link refresh).
 *
 * @module pages/ProjectDetail/decisions/decisionCache
 */
import type { ProjectDetail } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'

/** `detail` with `saved` in place of the document of the same id (prepended when new). */
export function withSavedDocument(detail: ProjectDetail | undefined, saved: ProjectDocument): ProjectDetail | undefined {
  if (detail === undefined) return undefined
  const exists = detail.documents.some((d) => d.document_id === saved.document_id)
  const documents = exists
    ? detail.documents.map((d) => (d.document_id === saved.document_id ? saved : d))
    : [saved, ...detail.documents]
  return { ...detail, documents }
}

/** `detail` without the document `documentId`. */
export function withoutDocument(detail: ProjectDetail | undefined, documentId: string): ProjectDetail | undefined {
  if (detail === undefined) return undefined
  return { ...detail, documents: detail.documents.filter((d) => d.document_id !== documentId) }
}
