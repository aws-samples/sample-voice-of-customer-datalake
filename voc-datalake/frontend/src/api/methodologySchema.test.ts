/**
 * @fileoverview The methodology blocks are read leniently at the boundary: a valid block keeps its
 * rows, a bad row is dropped without dropping the block, a malformed block is absent (never a throw).
 */
import { describe, expect, it } from 'vitest'
import { normalizeProjectDetail, normalizeProjectDocument } from './projectDetailSchema'
import { optionalMethodologyBlock, optionalProjectMethodology, serverMissing } from './methodologySchema'

const DOC = { document_id: 'prd_1', document_type: 'prd', title: 'PRD', content: '', created_at: '2026-11-07T00:00:00Z' }

describe('optionalMethodologyBlock', () => {
  it('keeps the skipped steps, warnings with their details, and the evidence count', () => {
    const block = optionalMethodologyBlock.parse({
      step: 'prd',
      skipped: [{ step: 'prfaq', reason: 'missing' }],
      warnings: [
        { code: 'missing_upstream', step: 'prfaq', message: 'This PRD is made without a PR/FAQ.' },
        { code: 'reference_documents_skipped', message: 'cap', document_ids: ['d1', 'd2'], cap: 3 },
      ],
      evidence: 12,
    })
    expect(block?.skipped).toStrictEqual([{ step: 'prfaq', reason: 'missing' }])
    expect(block?.warnings.map((w) => w.code)).toStrictEqual(['missing_upstream', 'reference_documents_skipped'])
    expect(block?.warnings[1]?.document_ids).toStrictEqual(['d1', 'd2'])
    expect(block?.evidence).toBe(12)
  })

  it('drops a row without a code or step, and keeps the rest of the block', () => {
    const block = optionalMethodologyBlock.parse({
      step: 'prfaq', skipped: [{ reason: 'missing' }, { step: 'personas' }],
      warnings: [{ message: 'no code' }, { code: 'no_evidence', message: 'x' }], evidence: 0,
    })
    expect(block?.skipped).toStrictEqual([{ step: 'personas', reason: 'missing' }])
    expect(block?.warnings.map((w) => w.code)).toStrictEqual(['no_evidence'])
    expect(block?.evidence).toBe(0)
  })

  it('reads an absent or non-object value as absent', () => {
    expect(optionalMethodologyBlock.parse(undefined)).toBeUndefined()
    expect(optionalMethodologyBlock.parse('nope')).toBeUndefined()
    expect(optionalMethodologyBlock.parse(null)).toBeUndefined()
  })

  it('rides on a normalized project document, absent on an older one', () => {
    const doc = normalizeProjectDocument({
      ...DOC, origin: 'human',
      methodology: { step: 'prd', skipped: [], warnings: [{ code: 'no_evidence', message: 'm' }], evidence: 0 },
    })
    expect(doc?.methodology?.evidence).toBe(0)
    expect(doc?.origin).toBe('human')
    expect(normalizeProjectDocument(DOC)?.methodology).toBeUndefined()
  })
})

describe('optionalProjectMethodology', () => {
  const OVERVIEW = {
    order: ['personas', 'research', 'prfaq', 'prd', 'prototype'],
    steps: {
      research: { missing: ['personas'], count: 0 },
      prd: { missing: ['personas', 'prfaq'], count: 0 },
      prototype: { missing: ['prd', 'prfaq'], count: 0, blocked: true },
    },
  }

  it('answers the server list per step, undefined for a step it did not name', () => {
    const overview = optionalProjectMethodology.parse(OVERVIEW)
    expect(serverMissing(overview, 'prd')).toStrictEqual(['personas', 'prfaq'])
    expect(overview?.steps.prototype?.blocked).toBe(true)
    expect(serverMissing(overview, 'prfaq')).toBeUndefined()
    expect(serverMissing(undefined, 'prd')).toBeUndefined()
  })

  it('is carried by the project detail, and absent from an older API', () => {
    const project = { project_id: 'p1', name: 'Example Air', created_at: '2026-11-07T00:00:00Z' }
    const detail = normalizeProjectDetail({ project, personas: [], documents: [], methodology: OVERVIEW })
    expect(serverMissing(detail.methodology, 'research')).toStrictEqual(['personas'])
    expect(normalizeProjectDetail({ project, personas: [], documents: [] }).methodology).toBeUndefined()
    expect(normalizeProjectDetail({ project, personas: [], documents: [], methodology: 7 }).methodology).toBeUndefined()
  })
})
