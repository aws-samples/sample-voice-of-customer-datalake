/**
 * @fileoverview What the import wizard sends (wizardMapping.ts): a reviews file's mapping with its dimensions, the
 * problems that stop an import, the import's tag, the rows' calls and the imported form's name.
 */
import { describe, expect, it } from 'vitest'
import type { Dimension } from '../../../api/dimensionsSchema'
import type { InferredForm } from '../../../api/importWizardSchema'
import {
  dimensionFor, eventBytes, formName, importCalls, importTag, redactedTextsPerRow, wizardMappingProblem, reviewsMapping,
} from './wizardMapping'

/** What a call holds at most: the texts a redacting source takes (lambda/shared/forms_v2_import.py), and 4 MB of event. */
const MAX_REDACTED_TEXTS = 250
const MAX_CALL_BYTES = 4 * 1024 * 1024

const dimension = (key: string, label: string): Dimension => ({ key, label, infer: false, values: [] })
const question = (id: string, type: string) => ({ id, type, headline: { en: id } })
const survey = (language: string, questions: readonly unknown[], hidden: readonly unknown[] = []): InferredForm =>
  ({ definition: { language, questions, hidden_fields: hidden }, mapping: {}, problems: [] })
const DIMENSIONS = [dimension('product', 'Product line'), dimension('user_type', 'Type of user')]

describe('a reviews file', () => {
  it('fills a dimension from a choice column named like it, by key or label', () => {
    expect(dimensionFor('Product', DIMENSIONS)?.key).toBe('product')
    expect(dimensionFor(' Type of úser ', DIMENSIONS)?.key).toBe('user_type')
    expect(dimensionFor('Plan', DIMENSIONS)).toBeUndefined()
    expect(reviewsMapping({ Comment: 'open_text', Product: 'choice', 'Type of user': 'choice', Plan: 'choice',
                            Mail: 'email' }, DIMENSIONS)).toStrictEqual({
      Comment: 'open_text', Product: 'dimension:product', 'Type of user': 'dimension:user_type', Plan: 'choice',
      Mail: 'email' })
  })

  it('needs an open-text column, a survey a question', () => {
    expect(wizardMappingProblem({ A: 'choice' }, 'reviews')).toBe('noText')
    expect(wizardMappingProblem({ A: 'open_text' }, 'reviews')).toBeNull()
    expect(wizardMappingProblem({ A: 'date', B: 'email' }, 'survey')).toBe('noQuestion')
    expect(wizardMappingProblem({ A: 'nps_0_10' }, 'survey')).toBeNull()
  })
})

describe('sending', () => {
  it('tags an import with its day and four letters', () => {
    expect(importTag(new Date('2026-11-21T10:00:00Z'), () => 0)).toBe('import-2026-11-21-aaaa')
    expect(importTag(new Date('2026-11-21T10:00:00Z'))).toMatch(/^import-2026-11-21-[a-z2-9]{4}$/u)
  })

  it('sends rows in calls of at most the texts a redacting source takes, each with its offset', () => {
    const rows = Array.from({ length: 260 }, (_unused, index) => ({ id: String(index) }))
    const calls = importCalls(rows, { first: 0, later: 0, textsPerRow: 2 })
    expect(calls.map((call) => [call.offset, call.items.length])).toStrictEqual([[0, 125], [125, 125], [250, 10]])
    expect(importCalls([], { first: 0, later: 0, textsPerRow: 1 })).toStrictEqual([])
  })

  it('sizes a survey by the texts each row sends to Comprehend: a 300-row survey with one open text goes as 125, 125, 50', () => {
    const rows = Array.from({ length: 300 }, (_unused, index) => ({ id: String(index) }))
    const form = survey('en', [question('q_nps', 'nps'), question('q_why', 'open_text'), question('q_plan', 'single_select')])
    expect(redactedTextsPerRow(form)).toBe(2) // its text and its one open answer
    const calls = importCalls(rows, { first: 0, later: 0, textsPerRow: redactedTextsPerRow(form) })
    expect(calls.map((call) => call.items.length)).toStrictEqual([125, 125, 50])
  })

  it("counts a hidden field's value too, and nothing for a language Comprehend does not read (Q34)", () => {
    const questions = [question('q_why', 'open_text'), question('q_more', 'open_text')]
    expect(redactedTextsPerRow(survey('es', questions, [{ id: 'channel' }]))).toBe(4)
    expect(redactedTextsPerRow(survey('de', questions, [{ id: 'channel' }]))).toBe(0)
    const rows = Array.from({ length: 6000 }, (_unused, index) => ({ id: String(index) }))
    // A German survey: only the 5,000 rows a call takes (and its size) split it.
    expect(importCalls(rows, { first: 0, later: 0, textsPerRow: 0 }).map((call) => call.items.length)).toStrictEqual([5000, 1000])
  })

  it('keeps every call, the first with the whole file, under the Lambda payload as its event carries it', () => {
    const rows = Array.from({ length: 600 }, (_unused, index) => ({ id: String(index), why: `"${'é'.repeat(10_000)}"` }))
    const file = { name: 'x.csv', format: 'csv', content: 'x"\n'.repeat(400_000) }
    const base = { mapping: { why: 'q_why' }, date_order: 'dmy', offset: 600 }
    const fields = (index: number) => (index === 0 ? { ...base, file } : { ...base, file_key: 'k'.repeat(120) })
    const calls = importCalls(rows, { first: eventBytes({ ...fields(0), rows: [] }), later: eventBytes({ ...fields(1), rows: [] }),
                                      textsPerRow: 1 })
    expect(calls.length).toBeGreaterThan(rows.length / MAX_REDACTED_TEXTS + 1)
    expect(calls[0]?.items.length).toBeLessThan(calls[1]?.items.length ?? 0)
    expect(calls.map((call, index) => eventBytes({ ...fields(index), rows: call.items, offset: call.offset }) <= MAX_CALL_BYTES))
      .toStrictEqual(calls.map(() => true))
    expect(calls.flatMap((call) => call.items)).toStrictEqual(rows)
  })

  it('names an imported form after its file', () => {
    expect(formName('Workshop results.csv')).toBe('Workshop results')
    expect(formName('.csv')).toBe('.csv')
  })
})
