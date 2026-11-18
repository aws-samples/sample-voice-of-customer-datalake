/**
 * @fileoverview NPS's "Ask detractors and promoters different questions" (UX §4.2): two long-text questions after
 * the NPS ("What's the main reason for your score?", "What do you value most?", in the form's language), with
 * "is at most 6 → the first" and "is at least 9 → the second". Passives go on where the form went before (the NPS's
 * Otherwise), and detractors skip the promoters' question.
 *
 * @module pages/FeedbackForms/questions/npsHelper
 */
import i18n from 'i18next'
import type { FormV2 } from '../model/formsV2'
import { textOf } from '../model/i18nText'
import { newQuestionId } from '../model/codes'
import { newQuestion } from '../model/defaults'
import { insertQuestion, questionIds, updateQuestion } from '../model/mutations'
import { fallthroughTarget } from '../model/paths'
import { withLogic } from '../model/rules'

export function withNpsFollowUps(form: FormV2, npsId: string): FormV2 {
  const index = form.questions.findIndex((q) => q.id === npsId)
  if (index === -1) return form
  const lng = form.language
  const copy = (key: string) => i18n.t(`feedbackForms:scale.npsHelper.${key}`, { lng })
  const before = fallthroughTarget(form, index)
  const detractorId = newQuestionId('detractor_reason', questionIds(form))
  const promoterId = newQuestionId('promoter_value', new Set([...questionIds(form), detractorId]))
  const detractor = { ...newQuestion('open_text', detractorId), headline: textOf(lng, copy('detractor')) }
  const promoter = { ...newQuestion('open_text', promoterId), headline: textOf(lng, copy('promoter')) }
  const routed = before === null ? detractor : withLogic(detractor, [], before)
  const withQuestions = insertQuestion(insertQuestion(form, routed, index + 1), promoter, index + 2)
  return updateQuestion(withQuestions, npsId, (q) => withLogic(q, [
    { when: { op: 'lte', value: 6 }, then: { jump_to: detractorId } },
    { when: { op: 'gte', value: 9 }, then: { jump_to: promoterId } },
  ], before))
}
