/**
 * @fileoverview `derivationKnowledge` reads the company-knowledge keys of a
 * document's derivation leniently: absent (every older document), null and
 * malformed values all read as "none", and junk entries are dropped one by one.
 */
import { describe, expect, it } from 'vitest'
import { derivationKnowledge } from './derivationKnowledge'

const NONE = { memory_ids: [], web_search_count: 0, company_context_included: false, design_system_included: null }

describe('derivationKnowledge', () => {
  it('reads the recorded keys', () => {
    const doc = { derivation: { memory_ids: ['mem_1', 'mem_2'], web_search_count: 3, company_context_included: true } }
    expect(derivationKnowledge(doc)).toStrictEqual({
      memory_ids: ['mem_1', 'mem_2'], web_search_count: 3, company_context_included: true,
      design_system_included: null,
    })
  })

  it.each([
    ['no derivation', {}],
    ['a null derivation', { derivation: null }],
    ['a pre-knowledge derivation', { derivation: { sources: [], feedback_count: 4 } }],
    ['not a document', 'prd_1'],
  ])('%s reads as none', (_label, doc) => {
    expect(derivationKnowledge(doc)).toStrictEqual(NONE)
  })

  it('drops junk entries and coerces wire numbers', () => {
    const doc = { derivation: { memory_ids: ['mem_1', '', 7, null], web_search_count: '2', company_context_included: 'yes' } }
    expect(derivationKnowledge(doc)).toStrictEqual({
      memory_ids: ['mem_1'], web_search_count: 2, company_context_included: false, design_system_included: null,
    })
  })

  it.each([
    [true, true], [false, false], [null, null], ['yes', null],
  ])('a prototype\'s design_system_included %s reads as %s', (stored, read) => {
    expect(derivationKnowledge({ derivation: { design_system_included: stored } }).design_system_included).toBe(read)
  })

  it('keeps the recorded keys when web_search_count is absent (it is written only when > 0)', () => {
    const doc = { derivation: { memory_ids: ['mem_1'], company_context_included: true } }
    expect(derivationKnowledge(doc)).toStrictEqual({
      memory_ids: ['mem_1'], web_search_count: 0, company_context_included: true, design_system_included: null,
    })
  })

  it('a negative or non-numeric count is zero', () => {
    expect(derivationKnowledge({ derivation: { web_search_count: -4 } }).web_search_count).toBe(0)
    expect(derivationKnowledge({ derivation: { web_search_count: 'many' } }).web_search_count).toBe(0)
  })
})
