/**
 * @fileoverview What a save of an answered form removes, as the server must be told (`removes` on
 * `PUT /feedback-forms/{id}`, docs/feedback-forms.md "Revisions"): once a form has a real response, the server
 * refuses (409 `answers_locked`) a save that drops a question id it had, or an option code of a question it keeps,
 * without naming it. A rename looks like a drop plus an add, so the lock holds on the server too, not only in the
 * builder (D9); a removal the person made in the builder (its confirm says the answers stay in Results) is named.
 *
 * @module pages/FeedbackForms/model/removals
 */
import type { FormV2, Question } from './formsV2'
import { isChoice } from './formsV2'

/** The wire's `removes`: the question ids dropped, and per question kept the option codes dropped. */
export interface FormRemovals {
  readonly questions?: readonly string[]
  readonly options?: Readonly<Record<string, readonly string[]>>
}

const codesOf = (question: Question | undefined): readonly string[] =>
  question !== undefined && isChoice(question) ? question.options.map((option) => option.code) : []

/**
 * What `form` drops from `stored` (the version the server holds): every question id it leaves out, and for each
 * question it keeps every option code it leaves out (all of them when the question is no longer a choice). Null when
 * it drops nothing.
 */
export function removalsOf(stored: FormV2, form: FormV2): FormRemovals | null {
  const kept = new Map(form.questions.map((question) => [question.id, question]))
  const questions = stored.questions.filter((question) => !kept.has(question.id)).map((question) => question.id)
  const options: Record<string, readonly string[]> = {}
  for (const question of stored.questions) {
    if (!kept.has(question.id)) continue
    const now = new Set(codesOf(kept.get(question.id)))
    const dropped = codesOf(question).filter((code) => !now.has(code))
    if (dropped.length > 0) options[question.id] = dropped
  }
  if (questions.length === 0 && Object.keys(options).length === 0) return null
  return { ...(questions.length > 0 ? { questions } : {}), ...(Object.keys(options).length > 0 ? { options } : {}) }
}
