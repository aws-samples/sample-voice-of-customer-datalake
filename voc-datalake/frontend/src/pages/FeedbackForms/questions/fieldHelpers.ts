/**
 * @fileoverview Small helpers of the editor's fields (questions/fields.tsx): a field's problems, and a number input's
 * value.
 *
 * @module pages/FeedbackForms/questions/fieldHelpers
 */
import type { FormProblem } from '../model/validateForm'

/** The problems of a card's field (and, for an option, of that option), for `TextField`'s `problems`. */
export function fieldProblems(problems: readonly FormProblem[], field: string, optionIndex?: number): FormProblem[] {
  return problems.filter((problem) => problem.at.field === field && (optionIndex === undefined || problem.at.optionIndex === optionIndex))
}

/** A number input's value: blank is undefined, anything else an integer (NaN dropped). */
export function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : undefined
}
