/**
 * The Product tab's lenient boundaries (7.104.00): a source from before 7.104.00 reads as a file with every new field
 * at its default, a status this bundle does not know reads as failed (never a spinner), a proposal field the answer
 * leaves out reads as a gap, an unreadable proposal as none, and a source route's answer without a source throws.
 */
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_CONTEXT_FIELDS, normalizeAcceptResult, normalizeProductDocAnswer, normalizeProductDocs,
  normalizeProductProposalLatest,
} from './productSourcesSchema'

describe('productSourcesSchema', () => {
  it('reads a source from before 7.104.00 as a file, and drops one without an id', () => {
    const { docs } = normalizeProductDocs({ docs: [
      { doc_id: 'd1', filename: 'a.md', content_type: 'text/markdown', size_bytes: 10, status: 'ready', error: null, extracted_chars: 5, created_at: 'x' },
      { filename: 'no-id.md' },
      { doc_id: 'd2', status: 'archived' },
    ] })
    expect(docs).toMatchObject([
      { doc_id: 'd1', source_kind: 'file', injection_flag: false, method: null, pages: null, truncated: false, url: null, interview_mode: null },
      { doc_id: 'd2', status: 'failed', filename: '' },
    ])
    expect(docs).toHaveLength(2)
  })

  it('reads every field of a proposal, a field left out as a gap, and the field_meta it can read', () => {
    const latest = normalizeProductProposalLatest({
      proposal: { proposal_id: 'pp', status: 'open', fields: { product_name: { status: 'proposed', value: 'X', citations: [{ source_id: 'S1', quote: 'q' }] } },
        questions: [{ field: 'non_goals', question: 'What is out?' }, { field: 'nope', question: 'dropped' }] },
      context: { product_name: 'Y', current_state: 'galaxy' },
      field_meta: { product_name: { by: 'person', sub: 's', at: 't' }, one_liner: { by: 'robot' } },
      sources: 'not a list',
    })
    expect(Object.keys(latest.proposal?.fields ?? {}).sort((a, b) => a.localeCompare(b))).toStrictEqual([...PRODUCT_CONTEXT_FIELDS].sort((a, b) => a.localeCompare(b)))
    expect(latest.proposal?.fields.product_name).toMatchObject({ status: 'proposed', value: 'X', citations: [{ source_id: 'S1', verified: false, page: null }] })
    expect(latest.proposal?.fields.one_liner).toMatchObject({ status: 'gap', value: '', accepted: false, changed_since: false })
    expect({
      questions: latest.proposal?.questions, name: latest.context.product_name, state: latest.context.current_state,
      meta: Object.keys(latest.field_meta), sources: latest.sources,
    }).toStrictEqual({ questions: [{ field: 'non_goals', question: 'What is out?' }], name: 'Y', state: '', meta: ['product_name'], sources: [] })
  })

  it('reads an unreadable proposal as none, and an unknown status as superseded (nothing to accept)', () => {
    expect(normalizeProductProposalLatest({ proposal: { status: 'open' } }).proposal).toBeNull()
    expect(normalizeProductProposalLatest({ proposal: { proposal_id: 'pp', status: 'archived' } }).proposal?.status).toBe('superseded')
  })

  it('throws for a source route answer that names no source, and reads the accept answer leniently', () => {
    expect(() => normalizeProductDocAnswer({ success: true })).toThrow(/no readable source/)
    expect(normalizeProductDocAnswer({ doc: { doc_id: 'd9' } }).doc).toMatchObject({ doc_id: 'd9', status: 'failed' })
    expect(normalizeAcceptResult({ applied: ['product_name', 'bogus'], conflicts: [{ field: 'one_liner', reason: 'person_value' }] }))
      .toStrictEqual({ applied: ['product_name'], conflicts: [{ field: 'one_liner', reason: 'person_value' }], status: 'open' })
    expect(normalizeAcceptResult(null)).toStrictEqual({ applied: [], conflicts: [], status: 'open' })
  })
})
