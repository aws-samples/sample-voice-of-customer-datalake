import { describe, expect, it } from 'vitest'
import type { FormV2, MatrixQuestion, Question } from './formsV2'
import { blankForm } from '../test/blankForm'
import { newQuestion } from './defaults'
import { parseFormV2, toWireForm } from './formsV2Schema'
import { matrixProblems } from './matrixProblems'
import { removeLanguage } from './mutations'
import { answerShape, removalsOf } from './removals'
import { missingTexts } from './translatable'
import { opsFor } from './rules'
import { isRecord } from '../../../lib/typeGuards'

const en = (text: string) => ({ en: text })
const matrix: MatrixQuestion = {
  id: 'q_phases', type: 'matrix', headline: en('How was each phase?'), required: true, shuffle_rows: false, display: 'auto',
  rows: [{ code: 'intro', label: en('Intro') }, { code: 'lab', label: en('Lab') }],
  columns: [{ code: 'poor', label: en('Poor'), score: 1 }, { code: 'good', label: en('Good'), score: 2 }, { code: 'great', label: en('Great') }],
}
const formWith = (...questions: Question[]): FormV2 => ({ ...blankForm('en'), questions })
/** `value` as JSON keeps it (undefined fields dropped, as a save sends it). */
const asSent = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
/** The first question's first row label, when it is a matrix. */
const firstRowLabel = (form: FormV2) => {
  const question = form.questions[0]
  return question?.type === 'matrix' ? question.rows[0]?.label : undefined
}
/** `min_rows` as a save sends the form's first question. */
function sentMinRows(q: MatrixQuestion): unknown {
  const questions = toWireForm(formWith(q)).questions
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined
  return isRecord(first) ? first.min_rows : 'no question'
}

describe('the matrix on the wire', () => {
  it('reads a stored matrix and writes it back as it was', () => {
    const parsed = parseFormV2(toWireForm(formWith(matrix)))
    expect(asSent(parsed?.questions)).toStrictEqual([matrix])
  })

  it('leaves out a malformed row or column, not the question, and reads unknown display and scores as their defaults', () => {
    const raw = { ...toWireForm(formWith(matrix)), questions: [{ ...matrix, display: 'carousel', shuffle_rows: 'yes',
      rows: [{ code: 'intro', label: en('Intro') }, { label: en('No code') }], columns: [{ code: 'poor', label: en('Poor'), score: 'x' }, 7] }] }
    const question = parseFormV2(raw)?.questions[0]
    expect(asSent(question)).toStrictEqual({ ...matrix, rows: [matrix.rows[0]], columns: [{ code: 'poor', label: en('Poor') }] })
  })

  it('sends min_rows only with an optional matrix (a required one asks for every row)', () => {
    expect([sentMinRows({ ...matrix, min_rows: 1 }), sentMinRows({ ...matrix, required: false, min_rows: 1 })]).toStrictEqual([undefined, 1])
  })
})

describe('a new matrix and its logic', () => {
  it('starts optional with two empty rows and four empty columns, shown automatically, in order', () => {
    const question = newQuestion('matrix', 'q_matrix')
    expect(question).toStrictEqual({
      id: 'q_matrix', type: 'matrix', headline: {}, required: false, shuffle_rows: false, display: 'auto',
      rows: [{ code: 'row', label: {} }, { code: 'row_2', label: {} }],
      columns: ['column', 'column_2', 'column_3', 'column_4'].map((code) => ({ code, label: {} })),
    })
  })

  it('takes only submitted and skipped rules (skipped while it is optional), and keeps one shape whatever its columns', () => {
    expect([opsFor(matrix), opsFor({ ...matrix, required: false })]).toStrictEqual([['submitted'], ['submitted', 'skipped']])
    expect(answerShape({ ...matrix, columns: [] })).toBe(answerShape(matrix))
  })
})

describe('the lock of an answered matrix', () => {
  it('names the rows and the columns a save drops, beside the options and questions', () => {
    const now = { ...matrix, rows: [{ code: 'lab', label: en('Lab') }], columns: matrix.columns.slice(0, 2) }
    expect(removalsOf(formWith(matrix), formWith(now))).toStrictEqual({ rows: { q_phases: ['intro'] }, columns: { q_phases: ['great'] } })
  })

  it('names every row and column of a matrix that became another type, and nothing for an unchanged one', () => {
    const asText = newQuestion('open_text', 'q_phases')
    expect(removalsOf(formWith(matrix), formWith(asText))).toStrictEqual({ rows: { q_phases: ['intro', 'lab'] }, columns: { q_phases: ['poor', 'good', 'great'] } })
    expect(removalsOf(formWith(matrix), formWith(matrix))).toBeNull()
  })
})

describe('translating a matrix', () => {
  const bilingual: FormV2 = { ...formWith(matrix), languages: ['en', 'pl'] }

  it('lists every row and column label for a translation, numbered in its list', () => {
    const fields = missingTexts(bilingual, 'pl').filter((entry) => entry.field.startsWith('matrix')).map((entry) => `${entry.field}${String(entry.number)}`)
    expect(fields).toStrictEqual(['matrixRow1', 'matrixRow2', 'matrixColumn1', 'matrixColumn2', 'matrixColumn3'])
  })

  it('writes one language of a row, and removing a language takes its row and column texts', () => {
    const row = missingTexts(bilingual, 'pl').find((entry) => entry.field === 'matrixRow')
    const written = row?.write(bilingual, 'pl', 'Wstęp') ?? bilingual
    expect(firstRowLabel(written)).toStrictEqual({ en: 'Intro', pl: 'Wstęp' })
    expect(firstRowLabel(removeLanguage(written, 'pl'))).toStrictEqual({ en: 'Intro' })
  })
})

describe('matrixProblems', () => {
  const codes = (q: MatrixQuestion) => matrixProblems(formWith(q), q).map((problem) => problem.code)

  it('finds nothing wrong with a complete matrix', () => {
    expect(codes(matrix)).toStrictEqual([])
  })

  it('counts rows and columns against their limits', () => {
    const many = Array.from({ length: 21 }, (_unused, n) => ({ code: `r${String(n)}`, label: en(`R${String(n)}`) }))
    expect(codes({ ...matrix, rows: [] })).toStrictEqual(['matrixNoRows'])
    expect(codes({ ...matrix, rows: many })).toStrictEqual(['matrixTooManyRows'])
    expect(codes({ ...matrix, columns: matrix.columns.slice(0, 1) })).toStrictEqual(['matrixFewColumns'])
    expect(codes({ ...matrix, columns: many.slice(0, 11) })).toStrictEqual(['matrixTooManyColumns'])
  })

  it('wants a label for every row and column, with its number and where it is', () => {
    const q = { ...matrix, rows: [matrix.rows[0], { code: 'lab', label: {} }].filter((row) => row !== undefined), columns: [{ code: 'a', label: {} }, ...matrix.columns.slice(1)] }
    expect(matrixProblems(formWith(q), q).map((p) => [p.code, p.at.field, p.at.optionIndex, p.params.number]))
      .toStrictEqual([['matrixRowEmpty', 'row', 1, 2], ['matrixColumnEmpty', 'column', 0, 1]])
  })

  it('refuses a code that is malformed, used twice in its list or names an object\'s own machinery', () => {
    const q = { ...matrix, rows: [{ code: 'Bad code', label: en('A') }, { code: 'constructor', label: en('B') }],
      columns: [{ code: 'x', label: en('X') }, { code: 'x', label: en('Y') }] }
    expect(codes(q)).toStrictEqual(['matrixCodeInvalid', 'matrixCodeReserved', 'matrixCodeTwice'])
  })

  it('takes a whole score from -100 to 100, and min_rows on an optional matrix from 1 to its rows', () => {
    const scores = { ...matrix, columns: [{ code: 'a', label: en('A'), score: 101 }, { code: 'b', label: en('B'), score: 1.5 }, { code: 'c', label: en('C'), score: -100 }] }
    expect(codes(scores)).toStrictEqual(['matrixScoreRange', 'matrixScoreRange'])
    expect([codes({ ...matrix, required: false, min_rows: 3 }), codes({ ...matrix, required: false, min_rows: 2 }), codes({ ...matrix, min_rows: 9 })])
      .toStrictEqual([['matrixMinRows'], [], []])
  })
})
