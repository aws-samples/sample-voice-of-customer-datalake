/**
 * The derivation contract at the query boundary: a document always answers
 * "what was I built from", a legacy document answers it in the same form, and no
 * sparse or malformed record can break a consumer.
 *
 * Every expectation is a literal — nothing here is derived from the code under
 * test.
 */
import { describe, it, expect } from 'vitest'
import {
  DERIVATION_ROLES,
  emptyDerivation,
  normalizeDerivation,
  resolveDerivation,
} from './derivation'

const PRD = { document_id: 'prd_1', document_type: 'prd', title: 'Onboarding PRD' }
const PRFAQ = { document_id: 'prfaq_1', document_type: 'prfaq', title: 'Onboarding PR/FAQ' }

describe('the role vocabulary', () => {
  it('is closed and lists the four relations the backend creates', () => {
    expect(DERIVATION_ROLES).toEqual(['reference', 'prototype_prd', 'prototype_prfaq', 'merge_input'])
  })
})

describe('a document with a declared derivation', () => {
  const doc = {
    document_id: 'prd_2',
    derivation: {
      sources: [
        { document_id: 'doc_e', role: 'reference' },
        { document_id: 'doc_d', role: 'reference' },
      ],
      selected_document_count: 5,
      feedback_count: 12,
      persona_ids: ['persona_1'],
      product_context_included: true,
    },
  }

  it('reports the sources in the order they were recorded', () => {
    expect(resolveDerivation(doc).sources.map((s) => s.document_id)).toEqual(['doc_e', 'doc_d'])
  })

  it('reports the selected count separately, so the dropped documents are visible', () => {
    const resolved = resolveDerivation(doc)
    expect(resolved.sources).toHaveLength(2)
    expect(resolved.selected_document_count).toBe(5)
  })

  it('reports the non-document inputs', () => {
    const resolved = resolveDerivation(doc)
    expect(resolved.feedback_count).toBe(12)
    expect(resolved.persona_ids).toEqual(['persona_1'])
    expect(resolved.product_context_included).toBe(true)
  })

  it('says the answer came from the declared field', () => {
    expect(resolveDerivation(doc).origin).toBe('declared')
  })

  it('coerces counts that arrive as strings or DynamoDB floats', () => {
    const resolved = resolveDerivation({
      derivation: { ...doc.derivation, selected_document_count: '5', feedback_count: 12.0 },
    })
    expect(resolved.selected_document_count).toBe(5)
    expect(resolved.feedback_count).toBe(12)
  })
})

describe('resolving sources against the project documents', () => {
  const doc = {
    derivation: {
      sources: [
        { document_id: 'prd_1', role: 'prototype_prd' },
        { document_id: 'deleted_1', role: 'prototype_prfaq' },
      ],
      selected_document_count: 2,
      feedback_count: 0,
      persona_ids: [],
      product_context_included: false,
    },
  }

  it('names a source that still exists', () => {
    expect(resolveDerivation(doc, [PRD]).sources[0]).toEqual({
      document_id: 'prd_1',
      role: 'prototype_prd',
      title: 'Onboarding PRD',
      document_type: 'prd',
      resolved: true,
    })
  })

  it('keeps a source whose document no longer exists, marked unresolved', () => {
    expect(resolveDerivation(doc, [PRD]).sources[1]).toEqual({
      document_id: 'deleted_1',
      role: 'prototype_prfaq',
      title: null,
      document_type: null,
      resolved: false,
    })
  })

  it('returns one entry per source even when nothing resolves', () => {
    const resolved = resolveDerivation(doc)
    expect(resolved.sources).toHaveLength(2)
    expect(
      resolved.sources.every((s) => s.resolved === false && s.title === null && s.document_type === null),
    ).toBe(true)
  })

  it('reports what kind of document each source is, not only its title', () => {
    // The role says how a source contributed; only document_type says what it
    // is. A consumer that renders a type badge beside a title must get both
    // from this one call rather than searching the document list again.
    const resolved = resolveDerivation(doc, [PRD, PRFAQ])
    expect(resolved.sources.map((s) => s.document_type)).toEqual(['prd', null])
  })

  it('reports an empty type for a source that resolved without one', () => {
    // Mirrors title exactly: present-but-unusable is '', absent is null, so no
    // consumer has to tell "resolved with no type" from "not resolved".
    const untyped = { document_id: 'doc_x', title: 'No type on the wire' }
    const resolved = resolveDerivation(
      { derivation: { sources: [{ document_id: 'doc_x', role: 'reference' }] } },
      [untyped],
    )
    expect(resolved.sources[0]).toEqual({
      document_id: 'doc_x',
      role: 'reference',
      title: 'No type on the wire',
      document_type: '',
      resolved: true,
    })
  })
})

describe('a legacy document with no declared derivation', () => {
  it('reads a prototype built from a PRD and a PR/FAQ', () => {
    const resolved = resolveDerivation(
      { document_id: 'prototype_1', source_prd_id: 'prd_1', source_prfaq_id: 'prfaq_1' },
      [PRD, PRFAQ],
    )
    expect(resolved.sources).toEqual([
      { document_id: 'prd_1', role: 'prototype_prd', title: 'Onboarding PRD', document_type: 'prd', resolved: true },
      { document_id: 'prfaq_1', role: 'prototype_prfaq', title: 'Onboarding PR/FAQ', document_type: 'prfaq', resolved: true },
    ])
    expect(resolved.origin).toBe('legacy')
  })

  it('treats a real stored null exactly like an absent key', () => {
    // A prototype built from a PR/FAQ alone stores source_prd_id: null; the
    // sibling key is absent entirely. Both must read as "no such source".
    const storedNull = resolveDerivation({ source_prd_id: null, source_prfaq_id: 'prfaq_1' })
    const absent = resolveDerivation({ source_prfaq_id: 'prfaq_1' })
    expect(storedNull.sources).toEqual([
      { document_id: 'prfaq_1', role: 'prototype_prfaq', title: null, document_type: null, resolved: false },
    ])
    expect(storedNull).toEqual(absent)
  })

  it('reads a merge output built from a list of documents', () => {
    const resolved = resolveDerivation({
      source_documents: ['doc_1', 'doc_2'],
      merge_instructions: 'Combine them',
    })
    expect(resolved.sources).toEqual([
      { document_id: 'doc_1', role: 'merge_input', title: null, document_type: null, resolved: false },
      { document_id: 'doc_2', role: 'merge_input', title: null, document_type: null, resolved: false },
    ])
    expect(resolved.origin).toBe('legacy')
  })

  it('reads a research report that only ever recorded a feedback count', () => {
    const resolved = resolveDerivation({ document_type: 'research', feedback_count: 42 })
    expect(resolved.feedback_count).toBe(42)
    expect(resolved.sources).toEqual([])
    expect(resolved.origin).toBe('legacy')
  })

  it('prefers the declared field when a document carries both', () => {
    const resolved = resolveDerivation({
      source_prd_id: 'prd_legacy',
      derivation: {
        sources: [{ document_id: 'prd_1', role: 'prototype_prd' }],
        selected_document_count: 1,
        feedback_count: 0,
        persona_ids: [],
        product_context_included: false,
      },
    })
    expect(resolved.sources.map((s) => s.document_id)).toEqual(['prd_1'])
    expect(resolved.origin).toBe('declared')
  })
})

describe('a document with no recoverable lineage', () => {
  it.each([
    ['no lineage fields at all', { document_id: 'doc_1', title: 'Hand written' }],
    ['a null derivation', { derivation: null }],
    ['an empty declared derivation', { derivation: emptyDerivation() }],
    ['an empty source list', { derivation: { ...emptyDerivation(), sources: [] } }],
    ['a derivation that is not an object', { derivation: 'built from vibes' }],
    ['an empty legacy list', { source_documents: [] }],
    ['a null document', null],
    ['a string instead of a document', 'not a document'],
    ['an array instead of a document', []],
  ])('reports exactly that, and does not throw: %s', (_case, input) => {
    const resolved = resolveDerivation(input)
    expect(resolved.origin).toBe('none')
    expect(resolved).toEqual({ ...emptyDerivation(), sources: [], origin: 'none' })
  })
})

describe('a malformed record', () => {
  it('drops only the malformed entries, keeping the readable ones', () => {
    const resolved = resolveDerivation({
      derivation: {
        sources: [
          { document_id: 'doc_1', role: 'reference' },
          { role: 'reference' }, // no id: points at nothing
          { document_id: '', role: 'reference' }, // empty id: same
          { document_id: 'doc_2', role: 'inspired_by' }, // role outside the vocabulary
          'doc_3', // not an entry at all
          null,
          { document_id: 'doc_4', role: 'merge_input' },
        ],
        selected_document_count: 7,
        feedback_count: 0,
        persona_ids: [],
        product_context_included: false,
      },
    })
    expect(resolved.sources).toEqual([
      { document_id: 'doc_1', role: 'reference', title: null, document_type: null, resolved: false },
      { document_id: 'doc_4', role: 'merge_input', title: null, document_type: null, resolved: false },
    ])
    expect(resolved.selected_document_count).toBe(7)
  })

  it('degrades individual bad fields without losing the rest', () => {
    const resolved = resolveDerivation({
      derivation: {
        sources: 'not a list',
        selected_document_count: 'nonsense',
        feedback_count: -3,
        persona_ids: ['persona_1', 42, null, ''],
        product_context_included: 'yes',
      },
    })
    expect(resolved.sources).toEqual([])
    expect(resolved.selected_document_count).toBe(0)
    expect(resolved.feedback_count).toBe(0)
    expect(resolved.persona_ids).toEqual(['persona_1'])
    expect(resolved.product_context_included).toBe(false)
  })

  it('does not let a malformed sibling reject the surrounding documents', () => {
    const documents: unknown[] = [
      { document_id: 'a', derivation: { sources: [{ document_id: 'prd_1', role: 'prototype_prd' }] } },
      { document_id: 'b', derivation: 'garbage' },
      { document_id: 'c', source_documents: ['doc_1'] },
    ]
    const resolved = documents.map((d) => resolveDerivation(d, [PRD]))
    expect(resolved.map((r) => r.origin)).toEqual(['declared', 'none', 'legacy'])
    expect(resolved).toHaveLength(3)
  })

  it('normalizes any value to a usable derivation', () => {
    for (const raw of [undefined, null, 0, '', [], 'x', { sources: null }]) {
      expect(normalizeDerivation(raw)).toEqual(emptyDerivation())
    }
  })
})

describe('a cyclic reference chain', () => {
  it('resolves each document once, without traversing into the cycle', () => {
    // A says it was built from B; B says it was built from A. The resolver reads
    // only a document's own sources, so there is no chain to follow and no way
    // to loop.
    const a = {
      document_id: 'a',
      document_type: 'custom',
      title: 'A',
      derivation: { sources: [{ document_id: 'b', role: 'merge_input' }] },
    }
    const b = {
      document_id: 'b',
      document_type: 'custom',
      title: 'B',
      derivation: { sources: [{ document_id: 'a', role: 'merge_input' }] },
    }

    const fromA = resolveDerivation(a, [a, b])
    const fromB = resolveDerivation(b, [a, b])

    expect(fromA.sources).toEqual([
      { document_id: 'b', role: 'merge_input', title: 'B', document_type: 'custom', resolved: true },
    ])
    expect(fromB.sources).toEqual([
      { document_id: 'a', role: 'merge_input', title: 'A', document_type: 'custom', resolved: true },
    ])
  })

  it('resolves a document that names itself as its own source, once', () => {
    const self = {
      document_id: 'self',
      document_type: 'prd',
      title: 'Self',
      derivation: { sources: [{ document_id: 'self', role: 'reference' }] },
    }

    expect(resolveDerivation(self, [self]).sources).toEqual([
      { document_id: 'self', role: 'reference', title: 'Self', document_type: 'prd', resolved: true },
    ])
  })
})
