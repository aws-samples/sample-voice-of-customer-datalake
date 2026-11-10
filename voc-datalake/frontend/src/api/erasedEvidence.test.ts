/**
 * @fileoverview The `erased_evidence` boundary (written by lambda/jobs/retention/lineage.py): a persona or
 * document keeps only a positive whole `count`; an unusable mark reads as none, and a row without one keeps
 * the key absent.
 */
import { describe, expect, it } from 'vitest'
import { normalizePersona, normalizeProjectDocument } from './projectDetailSchema'

const MARK = { count: 3, job_id: 'er_1', mode: 'erase', at: '2026-06-01T00:00:00Z' }
const PERSONA = { persona_id: 'persona_1', name: 'Ada', tagline: 'Flies weekly', created_at: '' }
const DOCUMENT = { document_id: 'prd_1', document_type: 'prd', title: 'Rebooking PRD', content: 'Body', created_at: '' }

describe('erased_evidence at the boundary', () => {
  it('keeps only the count of a stored mark', () => {
    expect(normalizePersona({ ...PERSONA, erased_evidence: MARK })?.erased_evidence).toStrictEqual({ count: 3 })
    expect(normalizeProjectDocument({ ...DOCUMENT, erased_evidence: MARK })?.erased_evidence).toStrictEqual({ count: 3 })
  })

  it.each([[{ count: 0 }], [{ count: 1.5 }], [{ count: '3' }], [{}], ['3'], [null]])('drops an unusable mark %j', (mark) => {
    expect(normalizePersona({ ...PERSONA, erased_evidence: mark })?.erased_evidence).toBeUndefined()
    expect(normalizeProjectDocument({ ...DOCUMENT, erased_evidence: mark })?.erased_evidence).toBeUndefined()
  })

  it('leaves the key out of a row without one', () => {
    expect(Object.hasOwn(normalizePersona(PERSONA) ?? {}, 'erased_evidence')).toBe(false)
  })
})
