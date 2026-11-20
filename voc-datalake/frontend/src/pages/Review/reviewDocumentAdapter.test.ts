/**
 * The shared document as the review page's adapter: read only for a reviewer, named by its document and version (a
 * version the server left out reads as 0, with no number), and read again as the share's newest version.
 */
import { describe, expect, it, vi } from 'vitest'
import { parseReviewAnswer } from '../../api/documentReviewSchema'
import { reviewDocumentAdapter } from './reviewDocumentAdapter'
import type { ReviewPageAnswer } from '../../api/documentReviewSchema'

const SHARE_ID = `shr_${'c'.repeat(32)}`
const answerAt = (version: number | null): ReviewPageAnswer => parseReviewAnswer({
  share: { share_id: SHARE_ID, document_type: 'prfaq', expires_at: '2026-11-27T10:00:00Z' },
  document: { document_id: 'doc_2', version, title: 'Faster refunds', content: 'Customers wait two weeks for a refund.' },
  threads: [],
})

describe('reviewDocumentAdapter', () => {
  it('is the share\'s, read only for a reviewer', () => {
    expect(reviewDocumentAdapter(SHARE_ID, vi.fn<() => Promise<ReviewPageAnswer>>())).toMatchObject({
      id: `review:${SHARE_ID}`, contentType: 'markdown', permissions: { edit: 'viewer' },
    })
  })

  it('names a version by its document and number, one without a number as 0', () => {
    const adapter = reviewDocumentAdapter(SHARE_ID, vi.fn<() => Promise<ReviewPageAnswer>>())
    expect(adapter.versionOf(answerAt(2).document)).toStrictEqual({ token: 'doc_2:2', number: 2 })
    expect(adapter.versionOf(answerAt(null).document)).toStrictEqual({ token: 'doc_2:0', number: undefined })
  })

  it('reads the share again for its newest version', async () => {
    const read = vi.fn<() => Promise<ReviewPageAnswer>>(() => Promise.resolve(answerAt(3)))
    const adapter = reviewDocumentAdapter(SHARE_ID, read)
    expect(await adapter.load(answerAt(2).document)).toMatchObject({ document_id: 'doc_2', version: 3 })
    expect(read).toHaveBeenCalledWith()
  })
})
