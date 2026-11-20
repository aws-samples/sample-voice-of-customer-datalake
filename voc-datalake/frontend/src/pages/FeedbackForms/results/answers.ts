/**
 * @fileoverview A stored answer as people read it (contract "Response, v2"): a choice by its option labels in the
 * form's primary language, Other with its typed text, a score as a number, a consent as accepted or not, contact
 * details joined, a matrix (7.61.00) as "Row: Column" per row it rated. Also a response's one-line summary for the Responses table (UX §10.4), its ending's title and its
 * hidden values.
 *
 * @module pages/FeedbackForms/results/answers
 */
import type { TFunction } from 'i18next'
import type { AnswerValue, FormResponse } from '../../../api/feedbackFormsV2Results'
import type { FormV2, Question } from '../model/formsV2'
import { isChoice } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { codeLabel } from '../logic/ruleSentence'

/** The label of Other on this question (its own, else the widget's word). */
function otherLabel(t: TFunction<'feedbackForms'>, form: FormV2, question: Question): string {
  const own = isChoice(question) ? textIn(question.other.label, form.language) : ''
  return own === '' ? t('results.other') : own
}

/** A matrix answer as "Row: Column" lines, in the question's row order, by their labels in the primary language (a
 * row or a column it no longer has by its code). */
export function matrixLines(form: FormV2, question: Question, rows: Readonly<Record<string, string>>): string[] {
  const rowOrder = question.type === 'matrix' ? question.rows : []
  const columns = new Map((question.type === 'matrix' ? question.columns : []).map((column) => [column.code, textIn(column.label, form.language) || column.code]))
  const known = rowOrder.filter((row) => rows[row.code] !== undefined).map((row) => ({ label: textIn(row.label, form.language) || row.code, code: row.code }))
  const gone = Object.keys(rows).filter((code) => !rowOrder.some((row) => row.code === code)).map((code) => ({ label: code, code }))
  return [...known, ...gone].map(({ label, code }) => {
    const column = rows[code] ?? ''
    return `${label}: ${columns.get(column) ?? column}`
  })
}

function objectText(t: TFunction<'feedbackForms'>, form: FormV2, question: Question, value: Exclude<AnswerValue, string | number | boolean>): string {
  if ('rows' in value) return matrixLines(form, question, value.rows).join('; ')
  if ('codes' in value) {
    const labels = value.codes.map((code) => codeLabel(t, form, question, code))
    const other = value.other === undefined || value.other === '' ? [] : [t('results.otherAnswer', { label: otherLabel(t, form, question), text: value.other })]
    return [...labels, ...other].join(', ')
  }
  if ('code' in value) return codeLabel(t, form, question, value.code)
  if ('other' in value) return t('results.otherAnswer', { label: otherLabel(t, form, question), text: value.other })
  return [value.name, value.email, value.phone, value.company].filter((part) => part !== undefined && part !== '').join(' · ')
}

/** One answer as text. */
export function answerText(t: TFunction<'feedbackForms'>, form: FormV2, question: Question, value: AnswerValue): string {
  if (typeof value === 'boolean') return value ? t('results.accepted') : t('results.notAccepted')
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return objectText(t, form, question, value)
}

/** The ending a response reached, by its title (or its id when the ending was removed). */
export function endingTitle(form: FormV2, endingId: string): string {
  const ending = form.endings.find((e) => e.id === endingId)
  const title = ending === undefined ? '' : textIn(ending.title, form.language)
  return title === '' ? endingId : title
}

/** The table's summary: the first two questions answered, then the first open text, quoted (UX §10.4). */
export function responseSummary(t: TFunction<'feedbackForms'>, form: FormV2, response: FormResponse): string {
  const answered = form.questions.filter((q) => response.answers[q.id] !== undefined && q.type !== 'open_text').slice(0, 2)
  const parts = answered.flatMap((q) => {
    const value = response.answers[q.id]
    return value === undefined ? [] : [answerText(t, form, q, value)]
  })
  const firstText = form.questions.find((q) => q.type === 'open_text' && typeof response.answers[q.id] === 'string')
  const text = firstText === undefined ? undefined : response.answers[firstText.id]
  const quoted = typeof text === 'string' && text !== '' ? [t('logic.values.quoted', { text })] : []
  return [...parts, ...quoted].join(' · ')
}

/** The declared hidden fields with the response's values ('' when it had none), then any others it carried. */
export function hiddenValues(form: FormV2, response: Pick<FormResponse, 'hidden'>): { readonly id: string; readonly value: string }[] {
  const declared = form.hidden_fields.map((field) => ({ id: field.id, value: response.hidden[field.id] ?? '' }))
  const known = new Set(form.hidden_fields.map((field) => field.id))
  const extra = Object.entries(response.hidden).filter(([id]) => !known.has(id)).map(([id, value]) => ({ id, value }))
  return [...declared, ...extra]
}
