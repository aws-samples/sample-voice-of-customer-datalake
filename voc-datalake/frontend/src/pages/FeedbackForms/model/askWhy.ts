/**
 * @fileoverview "Ask why when the score is low" (7.63.00, docs/feedback-forms.md "Ask why"): the builder's preset on a
 * rating, NPS, CSAT or CES question. It inserts an optional open text right after the score whose headline recalls it
 * ("What's the main reason for your score of {{q_x}}?", in the form's language), and gives the score its rules: a
 * score above the threshold (and a skip, on an optional question) jumps past the follow-up to where the form went
 * before, so only a low score is asked why. Everything it writes is an ordinary question and rule, editable as any.
 *
 * Low is NPS 6 or less, CSAT 3 or less, CES 3 or less, and a rating of 2 or less on a 5-point scale, scaled for the
 * others (`round(points × 2 ÷ 5)`: 1 of 3, 2 of 4, 3 of 7, 4 of 10). Offered while the question has no rules of its
 * own (an Otherwise only): its rules would decide first and could send a low score past the follow-up. The server reads
 * the same shape as a follow-up (lambda/shared/forms_v2_results.py `ask_why_pairs`: Results' `follow_up_of`).
 *
 * @module pages/FeedbackForms/model/askWhy
 */
import type { FormV2, Question, RatingQuestion, Rule, ScoreQuestion } from './formsV2'
import { isScale } from './formsV2'
import { textOf } from './i18nText'
import { newQuestionId } from './codes'
import { newQuestion } from './defaults'
import { insertQuestion, questionIds, updateQuestion } from './mutations'
import { fallthroughTarget, noMatchTarget } from './paths'
import { splitOtherwise, withLogic } from './rules'

type Scored = RatingQuestion | ScoreQuestion

/** The highest score that counts as low for `question`. */
export function lowScoreThreshold(question: Scored): number {
  switch (question.type) {
    case 'nps': return 6
    case 'csat': case 'ces': return 3
    case 'rating': return Math.round((question.range * 2) / 5)
  }
}

/** Can the preset be added to `question` (a scale with no rules of its own)? */
export function canAskWhy(question: Question): question is Scored {
  return isScale(question) && splitOtherwise(question).rules.length === 0
}

/**
 * `form` with the follow-up of the score `questionId` (its id new: none of the form's, nor a removed question's,
 * `retired`); null when the preset cannot be added there. `headline`: the follow-up's text in the form's language,
 * holding the score's placeholder.
 */
export function withAskWhy(form: FormV2, questionId: string, headline: (placeholder: string) => string,
  retired: ReadonlySet<string> = new Set()): FormV2 | null {
  const index = form.questions.findIndex((question) => question.id === questionId)
  const question = form.questions[index]
  if (question === undefined || !canAskWhy(question)) return null
  // Where a respondent went after the score before (its Otherwise, else the next question or the first ending).
  const onward = noMatchTarget(form, index)
  if (onward === null) return null
  const followUpId = newQuestionId(`${questionId.replace(/^q_/, '')}_why`, new Set([...questionIds(form), ...retired]))
  const followUp = { ...newQuestion('open_text', followUpId), required: false, headline: textOf(form.language, headline(`{{${questionId}}}`)) }
  const past: Rule[] = [
    { when: { op: 'gt', value: lowScoreThreshold(question) }, then: { jump_to: onward } },
    ...(question.required ? [] : [{ when: { op: 'skipped' as const }, then: { jump_to: onward } }]),
  ]
  // (the follow-up goes on where the score went: by itself when that is the next question, else by its Otherwise)
  const routed = onward === fallthroughTarget(form, index) ? followUp : withLogic(followUp, [], onward)
  const withFollowUp = insertQuestion(form, routed, index + 1)
  return updateQuestion(withFollowUp, questionId, (score) => withLogic(score, past, null))
}
