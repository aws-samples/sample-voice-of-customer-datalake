/**
 * @fileoverview The import wizard's wire shapes (importWizardSchema.ts): lenient reads of the detect and import
 * answers, and the kinds pinned to the server's list (lambda/shared/import_detect.py `KINDS`).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLUMN_KINDS, parseDetectAnswer, parseRowsImported } from './importWizardSchema'

describe('importWizardSchema', () => {
  it('lists the server\'s kinds, in its order', () => {
    const source = readFileSync(resolve(__dirname, '../../../lambda/shared/import_detect.py'), 'utf-8')
    const tuple = /^KINDS: Final = \(([^)]*)\)/mu.exec(source)?.[1] ?? ''
    expect([...tuple.matchAll(/'([a-z0-9_]+)'/gu)].map((m) => m[1])).toStrictEqual([...COLUMN_KINDS])
  })

  it('reads a detect answer leniently', () => {
    const answer = parseDetectAnswer({
      format: 'csv', delimiter: ';', headers: ['a'], row_count: 2,
      columns: [{ header: 'a', kind: 'stars', confidence: 2, reasons: [{ code: 'x', params: { n: 1 } }, 'junk'] }, 'junk'],
      suggested: { target: 'other', mapping: { a: 'open_text' }, date_order: 'dmy', form: null, form_problem: 'no_questions' },
    })
    expect(answer.columns).toStrictEqual([{ header: 'a', kind: 'ignore', confidence: 0, reasons: [{ code: 'x', params: { n: 1 } }],
      reason: '', personal: false, values: [], filled: 0 }])
    expect(answer.suggested).toStrictEqual({ target: 'reviews', mapping: { a: 'open_text' }, date_order: 'dmy', form: null,
      form_problem: 'no_questions' })
  })

  it('reads an import answer leniently', () => {
    expect(parseRowsImported({ accepted: 2, refused: [{ row: 3, code: 'date_invalid' }, { row: 'x' }], refused_count: 1,
      run_id: 'r', raw_s3_key: null })).toStrictEqual({ accepted: 2, refused: [{ row: 3, code: 'date_invalid' }],
      refused_count: 1, run_id: 'r', raw_s3_key: null })
  })
})
