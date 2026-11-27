/**
 * @fileoverview The form's recall problems (docs/feedback-forms.md "Recall"), from model/recall.ts: a recall
 * text whose `{{…}}` cannot be filled where it stands is an error that blocks Save, as the server's 400
 * (`recall_unknown`, `recall_not_before`, `recall_type`); a placeholder in a text where recall never works (a label, a
 * button, an address) blocks only Publish and Update live form (`blocks: 'publish'`), as the server's 409
 * `unresolved_placeholder` on a save that leaves a form live: a draft keeps it while it is fixed.
 *
 * @module pages/FeedbackForms/model/recallProblems
 */
import type { FormV2 } from './formsV2'
import { unresolvedPlaceholders } from './recall'
import type { RecallCode, TextLocation } from './recall'
import type { ProblemSeverity } from './ruleProblems'

export type RecallProblemCode = 'recallUnknown' | 'recallNotBefore' | 'recallType' | 'recallNotHere'

export interface RecallProblem {
  readonly severity: ProblemSeverity
  readonly code: RecallProblemCode
  readonly at: TextLocation
  readonly params: Readonly<Record<string, string>>
  readonly blocks?: 'publish'
}

const CODES: Readonly<Record<RecallCode, RecallProblemCode>> = {
  recall_unknown: 'recallUnknown', recall_not_before: 'recallNotBefore', recall_type: 'recallType', recall_not_here: 'recallNotHere',
}

/** Each placeholder respondents would see as written, as a problem at its text, with the language of the text (the
 * primary for an address). */
export function recallProblems(form: FormV2): RecallProblem[] {
  return unresolvedPlaceholders(form).map((found): RecallProblem => {
    const params = { placeholder: found.placeholder, language: found.language ?? form.language }
    const problem: RecallProblem = { severity: 'error', code: CODES[found.code], at: found.at, params }
    return found.code === 'recall_not_here' ? { ...problem, blocks: 'publish' } : problem
  })
}
