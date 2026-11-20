/**
 * @fileoverview What is wrong with a matrix question (7.61.00, docs/feedback-forms.md "Matrix"), as the server checks
 * it (lambda/shared/forms_v2.py): 1 to 20 rows and 2 to 10 columns, each with a label in the primary language and a
 * code (`[a-z0-9_]{1,40}`, unique in its list, never `__proto__`, `constructor` or `prototype`), a column's score a
 * whole number from -100 to 100, and `min_rows` (an optional matrix only) from 1 to the number of rows.
 *
 * @module pages/FeedbackForms/model/matrixProblems
 */
import type { FormV2, MatrixColumn, MatrixQuestion, MatrixRow } from './formsV2'
import { LIMITS } from './formsV2'
import { hasText } from './i18nText'
import { codeProblem, isReservedMatrixCode } from './codes'
import type { ProblemSeverity } from './ruleProblems'

export type MatrixProblemCode =
  | 'matrixNoRows' | 'matrixTooManyRows' | 'matrixFewColumns' | 'matrixTooManyColumns' | 'matrixRowEmpty' | 'matrixColumnEmpty'
  | 'matrixCodeInvalid' | 'matrixCodeTwice' | 'matrixCodeReserved' | 'matrixScoreRange' | 'matrixMinRows'

/** One problem of a matrix: where it is (`field` and, for a row or column, its index) and its message's values. */
export interface MatrixProblem {
  readonly severity: ProblemSeverity
  readonly code: MatrixProblemCode
  readonly at: { readonly kind: 'question'; readonly id: string; readonly field: string; readonly optionIndex?: number }
  readonly params: Readonly<Record<string, string | number>>
}

type Item = MatrixRow | MatrixColumn

/** The problem code of each way a row's or column's code is wrong. */
const CODE_PROBLEMS = { reserved: 'matrixCodeReserved', invalid: 'matrixCodeInvalid', taken: 'matrixCodeTwice' } as const

/** The problems of one list (`row` or `column`): an empty label, a code that cannot be used, a score out of range. */
function itemProblems(form: FormV2, q: MatrixQuestion, kind: 'row' | 'column', items: readonly Item[]): MatrixProblem[] {
  const at = (field: string, optionIndex: number) => ({ kind: 'question' as const, id: q.id, field, optionIndex })
  return items.flatMap((item, index): MatrixProblem[] => {
    const number = index + 1
    const found: MatrixProblem[] = []
    if (!hasText(item.label, form.language)) {
      found.push({ severity: 'error', code: kind === 'row' ? 'matrixRowEmpty' : 'matrixColumnEmpty', at: at(kind, index), params: { number } })
    }
    const wrong = codeProblem(item.code, items.slice(0, index).map((other) => other.code), isReservedMatrixCode)
    if (wrong !== '') found.push({ severity: 'error', code: CODE_PROBLEMS[wrong], at: at(`${kind}_code`, index), params: { code: item.code, number } })
    const score = 'score' in item ? item.score : undefined
    if (score !== undefined && (!Number.isInteger(score) || Math.abs(score) > LIMITS.matrixScore)) {
      found.push({ severity: 'error', code: 'matrixScoreRange', at: at('column_score', index), params: { number, max: LIMITS.matrixScore } })
    }
    return found
  })
}

/** The counts: rows, columns, and an optional matrix's `min_rows`. */
function countProblems(q: MatrixQuestion): MatrixProblem[] {
  const at = (field: string) => ({ kind: 'question' as const, id: q.id, field })
  const checks: readonly [boolean, MatrixProblemCode, string, Record<string, number>][] = [
    [q.rows.length === 0, 'matrixNoRows', 'rows', {}],
    [q.rows.length > LIMITS.matrixRows, 'matrixTooManyRows', 'rows', { max: LIMITS.matrixRows }],
    [q.columns.length < LIMITS.minMatrixColumns, 'matrixFewColumns', 'columns', { min: LIMITS.minMatrixColumns }],
    [q.columns.length > LIMITS.matrixColumns, 'matrixTooManyColumns', 'columns', { max: LIMITS.matrixColumns }],
    [!q.required && q.min_rows !== undefined && (q.min_rows < 1 || q.min_rows > q.rows.length), 'matrixMinRows', 'min_rows', { count: q.rows.length }],
  ]
  return checks.filter(([wrong]) => wrong).map(([, code, field, params]) => ({ severity: 'error', code, at: at(field), params }))
}

/** Every problem of a matrix question, in the editor's order: the counts, then the rows, then the columns. */
export function matrixProblems(form: FormV2, q: MatrixQuestion): MatrixProblem[] {
  return [...countProblems(q), ...itemProblems(form, q, 'row', q.rows), ...itemProblems(form, q, 'column', q.columns)]
}
