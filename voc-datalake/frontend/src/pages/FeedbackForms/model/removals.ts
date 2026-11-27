/**
 * @fileoverview What a save of an answered form removes, as the server must be told (`removes` on
 * `PUT /feedback-forms/{id}`, docs/feedback-forms.md "Revisions"): once a form has a real response, the server
 * refuses (409 `answers_locked`) a save that drops a question id it had, or an option code (a matrix's row or column
 * code) of a question it keeps, without naming it. A rename looks like a drop plus an add, so the lock holds
 * on the server too, not only in the builder (D9); a removal the person made in the builder (its confirm says the
 * answers stay in Results) is named.
 * A question it keeps keeps its type and range (`answerShape`): its answers are read on them, so another one is
 * refused whatever the save names (the builder locks the type select and a rating's points; `reshapedIds`).
 *
 * @module pages/FeedbackForms/model/removals
 */
import type { FormV2, Question } from './formsV2'
import { isChoice, isMatrix } from './formsV2'

/** The wire's `removes`: the question ids dropped, and per question kept the option, row and column codes dropped. */
export interface FormRemovals {
  readonly questions?: readonly string[]
  readonly options?: Readonly<Record<string, readonly string[]>>
  readonly rows?: Readonly<Record<string, readonly string[]>>
  readonly columns?: Readonly<Record<string, readonly string[]>>
}

type CodeList = 'options' | 'rows' | 'columns'

/** A question's codes of one kind: a choice's options, a matrix's rows or columns ([] for any other question). */
function codesOf(question: Question | undefined, list: CodeList): readonly string[] {
  if (question === undefined) return []
  if (list === 'options') return isChoice(question) ? question.options.map((option) => option.code) : []
  return isMatrix(question) ? question[list].map((item) => item.code) : []
}

/** What a question's answers mean (forms_v2.py `answer_shape`): its type and, for a rating, its points. */
export const answerShape = (question: Question): string => `${question.type}:${question.type === 'rating' ? String(question.range) : ''}`

/** The questions `form` keeps from `stored` (an answered form) with another type or range: the server's 409
 * `answers_locked` `changed`, in `stored`'s order. */
export function reshapedIds(stored: FormV2, form: FormV2): readonly string[] {
  const kept = new Map(form.questions.map((question) => [question.id, question]))
  return stored.questions.filter((question) => {
    const now = kept.get(question.id)
    return now !== undefined && answerShape(now) !== answerShape(question)
  }).map((question) => question.id)
}

/** Per question `form` keeps, the codes of one kind it drops from `stored`'s version of it. */
function droppedCodes(stored: FormV2, kept: ReadonlyMap<string, Question>, list: CodeList): Record<string, readonly string[]> {
  const dropped: Record<string, readonly string[]> = {}
  for (const question of stored.questions) {
    if (!kept.has(question.id)) continue
    const now = new Set(codesOf(kept.get(question.id), list))
    const gone = codesOf(question, list).filter((code) => !now.has(code))
    if (gone.length > 0) dropped[question.id] = gone
  }
  return dropped
}

/**
 * What `form` drops from `stored` (the version the server holds): every question id it leaves out, and for each
 * question it keeps every option, row and column code it leaves out (all of them when the question is no longer of
 * that kind). Null when it drops nothing.
 */
export function removalsOf(stored: FormV2, form: FormV2): FormRemovals | null {
  const kept = new Map(form.questions.map((question) => [question.id, question]))
  const questions = stored.questions.filter((question) => !kept.has(question.id)).map((question) => question.id)
  const parts = (['options', 'rows', 'columns'] as const).flatMap((list) => {
    const dropped = droppedCodes(stored, kept, list)
    return Object.keys(dropped).length > 0 ? [[list, dropped] as const] : []
  })
  if (questions.length === 0 && parts.length === 0) return null
  return { ...(questions.length > 0 ? { questions } : {}), ...Object.fromEntries(parts) }
}
