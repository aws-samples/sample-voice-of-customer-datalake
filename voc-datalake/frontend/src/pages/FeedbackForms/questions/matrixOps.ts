/**
 * @fileoverview The matrix editor's edits as pure functions (docs/feedback-forms.md "Matrix"): rows and
 * columns added (a code made from the label, never `__proto__`, `constructor` or `prototype`), a label edit that
 * carries a fresh row's or column's code along until the form is saved, and a new matrix's scale in the form's own
 * language (four columns scored 1 to 4).
 *
 * @module pages/FeedbackForms/questions/matrixOps
 */
import i18n from 'i18next'
import type { FormLanguage, MatrixColumn, MatrixQuestion, MatrixRow } from '../model/formsV2'
import { LIMITS } from '../model/formsV2'
import { codeSlug, uniqueSlug } from '../model/codes'
import { textOf, withText } from '../model/i18nText'
import { moved } from '../model/mutations'

/** A matrix's two lists. */
export type MatrixList = 'rows' | 'columns'

const MACHINERY: readonly string[] = ['__proto__', 'constructor', 'prototype']
const LIMIT: Readonly<Record<MatrixList, number>> = { rows: LIMITS.matrixRows, columns: LIMITS.matrixColumns }
const FALLBACK: Readonly<Record<MatrixList, string>> = { rows: 'row', columns: 'column' }

/** The key of a fresh row or column in the draft's `freshCodes` (its code follows its label until the save). */
export const matrixFreshKey = (questionId: string, list: MatrixList, code: string): string => `${questionId}:${list}:${code}`

/** A code for a row or column labelled `label`, none of `taken` (nor an object's own machinery). */
function codeFor(list: MatrixList, label: string, taken: Iterable<string>): string {
  const base = codeSlug(label)
  return uniqueSlug(base === '' ? FALLBACK[list] : base, new Set([...taken, ...MACHINERY]))
}

const codesOf = (question: MatrixQuestion, list: MatrixList, except?: number): string[] =>
  question[list].filter((_item, index) => index !== except).map((item) => item.code)

/** `question` with a new row or column (labelled `label`) at `at`, and its code; unchanged at the list's limit. */
export function withNewItem(question: MatrixQuestion, list: MatrixList, at: number, label: string, language: FormLanguage): { question: MatrixQuestion; code: string | null } {
  if (question[list].length >= LIMIT[list]) return { question, code: null }
  const code = codeFor(list, label, codesOf(question, list))
  const item = { code, label: textOf(language, label) }
  const items = [...question[list].slice(0, at), item, ...question[list].slice(at)]
  return { question: { ...question, [list]: items }, code }
}

/** `question` with row or column `index`'s label set; a fresh one's code follows it (the new code is returned). */
export function withItemLabel(question: MatrixQuestion, list: MatrixList, index: number, label: string, language: FormLanguage, fresh: boolean): { question: MatrixQuestion; code: string } {
  const item = question[list][index]
  if (item === undefined) return { question, code: '' }
  const code = fresh ? codeFor(list, label, codesOf(question, list, index)) : item.code
  const next = { ...item, code, label: withText(item.label, language, label) }
  return { question: { ...question, [list]: question[list].map((other, at) => (at === index ? next : other)) }, code }
}

/** `question` with row or column `index`'s code typed by hand (the caller checked it). */
export const withItemCode = (question: MatrixQuestion, list: MatrixList, index: number, code: string): MatrixQuestion =>
  ({ ...question, [list]: question[list].map((item, at) => (at === index ? { ...item, code } : item)) })

/** `question` without row or column `index` (a required row count goes with it: `min_rows` stays within the rows). */
export function withoutItem(question: MatrixQuestion, list: MatrixList, index: number): MatrixQuestion {
  const items: readonly (MatrixRow | MatrixColumn)[] = question[list].filter((_item, at) => at !== index)
  const next = { ...question, [list]: items }
  return list === 'rows' && next.min_rows !== undefined && next.min_rows > next.rows.length
    ? { ...next, min_rows: next.rows.length === 0 ? undefined : next.rows.length } : next
}

/** `question` with row or column `from` moved to `to`. */
export const withItemMoved = (question: MatrixQuestion, list: MatrixList, from: number, to: number): MatrixQuestion =>
  ({ ...question, [list]: moved(question[list], from, to) })

/** `question` with column `index` scored `score` (undefined: no score). */
export const withColumnScore = (question: MatrixQuestion, index: number, score: number | undefined): MatrixQuestion =>
  ({ ...question, columns: question.columns.map((column, at) => (at === index ? { ...column, score } : column)) })

const SCALE = ['poor', 'fair', 'good', 'excellent'] as const

/** A new matrix's scale in the form's language: Poor, Fair, Good, Excellent, scored 1 to 4 (codes from the labels). */
export function withDefaultScale(question: MatrixQuestion, language: FormLanguage): MatrixQuestion {
  const taken: string[] = []
  const columns = SCALE.map((key, index): MatrixColumn => {
    const label = i18n.t(`feedbackForms:matrix.scale.${key}`, { lng: language })
    const code = codeFor('columns', label, taken)
    taken.push(code)
    return { code, label: textOf(language, label), score: index + 1 }
  })
  return { ...question, columns }
}
