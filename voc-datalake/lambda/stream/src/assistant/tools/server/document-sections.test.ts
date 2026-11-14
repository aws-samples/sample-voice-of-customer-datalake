/**
 * The stream's copy of the document sections table (docs/prototype-builder.md "Part 4"): the order, every known
 * type's section, unknown and non-string types in Documents, the read's own `section` first, the legacy sort key.
 */
import { describe, expect, it } from 'vitest';
import { SECTION_ORDER, documentSection, groupBySection, sectionOfDocument } from './document-sections.js';

describe('SECTION_ORDER', () => {
  it('is PRD, PR/FAQ, Prototypes, Documents', () => {
    expect(SECTION_ORDER).toStrictEqual(['prd', 'prfaq', 'prototypes', 'documents']);
  });
});

describe('documentSection', () => {
  it.each([
    ['prd', 'prd'], ['prfaq', 'prfaq'], ['prototype', 'prototypes'], ['research', 'documents'], ['custom', 'documents'],
    ['product_report', 'documents'], ['decision', 'documents'],
  ])('%s → %s', (type, section) => {
    expect(documentSection(type)).toBe(section);
  });

  it.each([['an unknown type', 'roadmap'], ['a prototype key', 'constructor'], ['a number', 7], ['none', undefined], ['upper case', 'PRD']])(
    '%s is in Documents',
    (_label, type) => {
      expect(documentSection(type)).toBe('documents');
    },
  );
});

describe('sectionOfDocument', () => {
  it('takes the read’s own section when it is one of the four', () => {
    expect(sectionOfDocument({ document_type: 'research', section: 'prd' })).toBe('prd');
  });

  it('falls back to the type when the section is missing or unknown', () => {
    expect(sectionOfDocument({ document_type: 'prfaq' })).toBe('prfaq');
    expect(sectionOfDocument({ document_type: 'prototype', section: 'later' })).toBe('prototypes');
    expect(sectionOfDocument({ document_type: 'prd', section: 3 })).toBe('prd');
  });

  it.each([
    [{ sk: 'PRFAQ#q1' }, 'prfaq'],
    [{ sk: 'PROTOTYPE#p1' }, 'prototypes'],
    [{ sk: 'META' }, 'documents'],
    [{ sk: 9 }, 'documents'],
    [{}, 'documents'],
  ])('reads a legacy row with no type by its sort key prefix: %o', (row, section) => {
    expect(sectionOfDocument(row)).toBe(section);
  });
});

describe('groupBySection', () => {
  it('keeps all four sections in order, empty ones too, each last edit first (updated_at, else created_at)', () => {
    const rows = [
      { document_id: 'made-late', document_type: 'prd', created_at: '2026-03-01' },
      { document_id: 'r', document_type: 'research', created_at: '2026-01-01' },
      { document_id: 'edited', document_type: 'prd', created_at: '2026-01-01', updated_at: '2026-04-01' },
      { document_id: 'oldest', document_type: 'prd', created_at: '2026-02-01', updated_at: '' },
    ];
    expect(groupBySection(rows, (row) => row.document_id)).toStrictEqual([
      { section: 'prd', documents: ['edited', 'made-late', 'oldest'] },
      { section: 'prfaq', documents: [] },
      { section: 'prototypes', documents: [] },
      { section: 'documents', documents: ['r'] },
    ]);
  });

  it('breaks a tie of dates by document_id, and puts a row with no date last', () => {
    const rows = [
      { document_id: 'b', document_type: 'prd', created_at: '2026-01-01' },
      { document_id: 'undated', document_type: 'prd', updated_at: 7 },
      { document_id: 'a', document_type: 'prd', updated_at: '2026-01-01' },
    ];
    expect(groupBySection(rows, (row) => row.document_id)[0]?.documents).toStrictEqual(['a', 'b', 'undated']);
  });

  it('lists four empty sections for a project with no documents', () => {
    expect(groupBySection([], (row) => row).map((group) => group.documents.length)).toStrictEqual([0, 0, 0, 0]);
  });
});
