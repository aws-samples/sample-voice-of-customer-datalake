/**
 * @fileoverview The shared document on `/review/:shareId` as a document adapter (components/Document/types.ts): read
 * only for a reviewer (`viewer`: "You can read this and comment."), its newest version (`GET /review/{share}`); the
 * comment writes (`POST …/comments`, `…/replies`) are the surface's comment actions (ReviewDocument).
 *
 * @module pages/Review/reviewDocumentAdapter
 */
import type { DocumentAdapter } from '../../components/Document/types'
import type { ReviewPageAnswer } from '../../api/documentReviewSchema'

export type ReviewedDocument = ReviewPageAnswer['document']

export function reviewDocumentAdapter(shareId: string, read: () => Promise<ReviewPageAnswer>): DocumentAdapter<ReviewedDocument> {
  return {
    id: `review:${shareId}`,
    contentType: 'markdown',
    permissions: { edit: 'viewer' },
    versionOf: (stored) => ({ token: `${stored.document_id}:${String(stored.version ?? 0)}`, number: stored.version ?? undefined }),
    load: async () => (await read()).document,
  }
}
