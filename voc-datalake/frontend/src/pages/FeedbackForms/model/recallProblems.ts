/**
 * @fileoverview The form's recall problems (7.61.00, docs/feedback-forms.md "Recall"), from model/recall.ts: a recall
 * text whose `{{…}}` cannot be filled where it stands (`recall_unknown`, `recall_not_before`, `recall_type`), and a
 * placeholder in a text where recall never works (a label, a button, an address), block only Publish and Update live
 * form (`blocks: 'publish'`), as the server's 409 `unresolved_placeholder` on a save that leaves a form live, its one
 * recall rule since 7.63.00: a draft keeps them while they are fixed.
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
    return { severity: 'error', code: CODES[found.code], at: found.at, params, blocks: 'publish' }
  })
}
