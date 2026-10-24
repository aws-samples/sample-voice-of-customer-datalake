import { describe, expect, it } from 'vitest'
import { decisionFromDocument, decisionsOf, isVerdict } from './decisionSchema'

const decisionDoc = (id: string, decidedAt: string, verdict: unknown = 'pursue') => ({
  document_id: id, document_type: 'decision', title: `Decision ${id}`, revision: 2, created_at: '2026-10-01T00:00:00Z',
  decision: {
    verdict, rationale: 'Why', success_metric: 'KPI', evidence: { feedback_ids: ['fb_1', ''], document_ids: ['prd_1'] },
    review_by: '2026-12-01', decided_by: 'sub-user', decided_by_name: 'Ana', decided_at: decidedAt,
  },
  seeded_prfaq_job_id: 'job-1',
})

describe('decisionFromDocument', () => {
  it('reads every field of a decision document', () => {
    const decision = decisionFromDocument(decisionDoc('d1', '2026-10-02T00:00:00Z'))
    expect(decision).toMatchObject({ documentId: 'd1', verdict: 'pursue', successMetric: 'KPI', killCriterion: '' })
    expect(decision?.feedbackIds).toStrictEqual(['fb_1'])
    expect(decision).toMatchObject({ launchedAt: null, revision: 2, seededPrfaqJobId: 'job-1', decidedByName: 'Ana' })
  })

  it('is null for any other document or an unknown verdict', () => {
    expect(decisionFromDocument({ document_id: 'x', document_type: 'prd', title: 'P' })).toBeNull()
    expect(decisionFromDocument(decisionDoc('d1', '2026-10-02', 'maybe'))).toBeNull()
    expect(decisionFromDocument(null)).toBeNull()
  })

  it('falls back to created_at when no decided_at is stored', () => {
    expect(decisionFromDocument(decisionDoc('d1', ''))?.decidedAt).toBe('2026-10-01T00:00:00Z')
  })
})

describe('decisionsOf', () => {
  it('keeps decisions only, the most recently decided first', () => {
    const docs = [decisionDoc('old', '2026-10-01'), { document_id: 'p', document_type: 'prd' }, decisionDoc('new', '2026-10-05')]
    expect(decisionsOf(docs).map((d) => d.documentId)).toStrictEqual(['new', 'old'])
  })
})

describe('isVerdict', () => {
  it.each([['pursue', true], ['park', true], ['reject', true], ['later', false], [null, false]])('%s → %s', (value, expected) => {
    expect(isVerdict(value)).toBe(expected)
  })
})
