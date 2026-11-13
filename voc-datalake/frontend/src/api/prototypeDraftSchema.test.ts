/**
 * @fileoverview The prototype draft GET's boundary (docs/prototype-builder.md, part 2): a draft the page
 * cannot show is null, the preview URL is http(s) only (it becomes a frame source), the texts are capped,
 * and the summary reads as its non-blank lines.
 */
import { describe, it, expect } from 'vitest'
import { normalizePrototypeDraft, summaryLines } from './prototypeDraftSchema'

const DRAFT = {
  draft_id: 'job_1', base_document_id: 'proto_2', base_version: 2, instruction: 'make the footer sticky',
  summary: 'Checkout: the footer sticks', preview_url: 'https://cdn.example.com/prototypes/p1/drafts/job_1.html',
}

describe('normalizePrototypeDraft', () => {
  it('keeps a whole draft as it is', () => {
    expect(normalizePrototypeDraft(DRAFT)).toStrictEqual(DRAFT)
  })

  it('refuses a draft it cannot show: no id, no base or no version number', () => {
    expect(normalizePrototypeDraft({ ...DRAFT, draft_id: '' })).toBeNull()
    expect(normalizePrototypeDraft({ ...DRAFT, base_document_id: undefined })).toBeNull()
    expect(normalizePrototypeDraft({ ...DRAFT, base_version: 'two' })).toBeNull()
    expect(normalizePrototypeDraft(null)).toBeNull()
  })

  it('keeps only an http(s) preview URL and caps the texts', () => {
    expect(normalizePrototypeDraft({ ...DRAFT, preview_url: 'javascript:alert(1)' })?.preview_url).toBeNull()
    expect(normalizePrototypeDraft({ ...DRAFT, preview_url: null })?.preview_url).toBeNull()
    expect(normalizePrototypeDraft({ ...DRAFT, summary: 'x'.repeat(3000) })?.summary).toHaveLength(2000)
    expect(normalizePrototypeDraft({ ...DRAFT, instruction: 7 })?.instruction).toBe('')
  })
})

describe('summaryLines', () => {
  it('splits the summary into its non-blank lines', () => {
    expect(summaryLines('Checkout: sticky\r\n\n  Cart: unchanged  \n')).toStrictEqual(['Checkout: sticky', 'Cart: unchanged'])
  })
})
