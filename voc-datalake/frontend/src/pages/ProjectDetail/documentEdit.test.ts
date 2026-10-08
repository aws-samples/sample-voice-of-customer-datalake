import { describe, it, expect } from 'vitest'
import type { ProjectDocument } from '../../api/types'
import { documentRevision, latestDocument } from './documentEdit'

const doc = (over: Partial<ProjectDocument>): ProjectDocument => ({
  document_id: 'd', document_type: 'custom', title: 'T', content: '', created_at: '', ...over,
})

describe('documentRevision', () => {
  it('a research / custom document sends its edit counter, unset = 1 (as the server reads it)', () => {
    expect(documentRevision(doc({ revision: 4 }))).toBe(4)
    expect(documentRevision(doc({}))).toBe(1)
  })

  it('a PRD / PR-FAQ sends its series version', () => {
    expect(documentRevision(doc({ document_type: 'prd', version: 3, revision: 9 }))).toBe(3)
  })

  it('a managed row without a version (not backfilled yet) sends none: no check, no false 409', () => {
    expect(documentRevision(doc({ document_type: 'custom', sk: 'PRFAQ#x' }))).toBeUndefined()
  })
})

describe('latestDocument', () => {
  it('an unmanaged document is the same row, freshly read', () => {
    const fresh = doc({ document_id: 'a', content: 'new', revision: 3 })
    expect(latestDocument([doc({ document_id: 'b' }), fresh], doc({ document_id: 'a' }))).toBe(fresh)
  })

  it('a PRD is the head of its own series (the edit made a new row)', () => {
    const v1 = doc({ document_id: 'p1', document_type: 'prd', base_title: 'Launch', title: 'Launch (v1)', version: 1 })
    const v3 = doc({ document_id: 'p3', document_type: 'prd', base_title: 'Launch', title: 'Launch (v3)', version: 3 })
    const otherSeries = doc({ document_id: 'q9', document_type: 'prd', base_title: 'Other', title: 'Other (v9)', version: 9 })
    const sameTitleOtherType = doc({ document_id: 'f5', document_type: 'prfaq', base_title: 'Launch', title: 'Launch (v5)', version: 5 })
    expect(latestDocument([v1, otherSeries, v3, sameTitleOtherType], v1)).toBe(v3)
  })

  it('a document deleted meanwhile is undefined', () => {
    expect(latestDocument([], doc({ document_id: 'gone' }))).toBeUndefined()
  })
})
