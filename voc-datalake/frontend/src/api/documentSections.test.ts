/**
 * The document sections (docs/prototype-builder.md "Part 4"): the one order, every type the SPA knows in its section,
 * an unknown type in Documents, the read's own `section` first, newest first by last edit, and the stream's copy of
 * the table (the assistant's `get_project`) agreeing with this one.
 */
import { describe, expect, it } from 'vitest'
import { DOCUMENT_SECTIONS, byNewestEdit, documentSection, groupBySection, sectionOf } from './documentSections'
import { SECTION_ORDER, documentSection as streamDocumentSection } from '@stream/assistant/tools/server/document-sections'
import type { KnownProjectDocumentType } from './types'

/** Every `KnownProjectDocumentType` (a type added there without a row here fails to compile). */
const KNOWN: Readonly<Record<KnownProjectDocumentType, string>> = {
  prd: 'prd', prfaq: 'prfaq', prototype: 'prototypes', research: 'documents', custom: 'documents',
  product_report: 'documents', decision: 'documents',
}

describe('DOCUMENT_SECTIONS', () => {
  it('is PRD, PR/FAQ, Prototypes, Documents, as the stream lists them', () => {
    expect(DOCUMENT_SECTIONS).toStrictEqual(['prd', 'prfaq', 'prototypes', 'documents'])
    expect(SECTION_ORDER).toStrictEqual(DOCUMENT_SECTIONS)
  })
})

describe('documentSection', () => {
  it.each(Object.entries(KNOWN))('%s → %s, in the SPA and in the stream', (type, section) => {
    expect([documentSection(type), streamDocumentSection(type)]).toStrictEqual([section, section])
  })

  it.each([['an unknown type', 'roadmap'], ['an inherited key', 'constructor'], ['upper case', 'PRD'], ['a number', 3], ['none', undefined]])(
    '%s is in Documents',
    (_label, type) => {
      expect([documentSection(type), streamDocumentSection(type)]).toStrictEqual(['documents', 'documents'])
    },
  )
})

describe('sectionOf', () => {
  it('takes the read’s own section, else the table', () => {
    expect(sectionOf({ document_type: 'research', section: 'prfaq' })).toBe('prfaq')
    expect(sectionOf({ document_type: 'prototype' })).toBe('prototypes')
    expect(sectionOf({ document_type: 'prd', section: 'later' })).toBe('prd')
  })
})

describe('byNewestEdit', () => {
  it('orders by updated_at, else created_at, newest first; ties by id', () => {
    const rows = [
      { document_id: 'b', created_at: '2026-01-01' },
      { document_id: 'edited', created_at: '2025-01-01', updated_at: '2026-03-01' },
      { document_id: 'a', created_at: '2026-01-01' },
      { document_id: 'blank', created_at: '2026-02-01', updated_at: '' },
      { document_id: 'undated' },
    ]
    expect([...rows].sort(byNewestEdit).map((row) => row.document_id)).toStrictEqual(['edited', 'blank', 'a', 'b', 'undated'])
  })
})

describe('groupBySection', () => {
  it('lists all four sections in order, empty ones kept, each in the order given', () => {
    const groups = groupBySection([
      { document_id: 'r', document_type: 'research' },
      { document_id: 'p2', document_type: 'prd' },
      { document_id: 'x', document_type: 'roadmap' },
      { document_id: 'p1', document_type: 'prd' },
    ])
    expect(groups.map(({ section, documents }) => [section, documents.map((d) => d.document_id)])).toStrictEqual([
      ['prd', ['p2', 'p1']], ['prfaq', []], ['prototypes', []], ['documents', ['r', 'x']],
    ])
  })
})
