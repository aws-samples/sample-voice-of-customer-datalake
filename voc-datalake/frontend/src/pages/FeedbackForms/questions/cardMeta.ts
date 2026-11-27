/**
 * @fileoverview A question card's meta line (UX §3.3), by type: "7 options · Other", "Long text · up to 2,000
 * characters", "0–10", "1–5 stars", "Must be ticked", "Name · Email".
 *
 * @module pages/FeedbackForms/questions/cardMeta
 */
import type { TFunction } from 'i18next'
import type { Question } from '../model/formsV2'
import { CONTACT_FIELDS } from '../model/formsV2'
import { scaleOf } from '../model/rules'

function choiceMeta(t: TFunction<'feedbackForms'>, question: Extract<Question, { type: 'single_select' | 'multi_select' }>): string[] {
  const parts = [t('questionList.meta.options', { count: question.options.length })]
  if (question.other.enabled) parts.push(t('questionList.meta.other'))
  if (question.type === 'multi_select' && question.none.enabled) parts.push(t('questionList.meta.none'))
  return parts
}

function scaleMeta(t: TFunction<'feedbackForms'>, question: Question): string[] {
  const scale = scaleOf(question)
  if (scale === null) return []
  const range = t('questionList.meta.range', { min: scale.min, max: scale.max })
  return question.type === 'rating' ? [t(`questionList.meta.scale.${question.scale}`, { range })] : [range]
}

function textMeta(t: TFunction<'feedbackForms'>, question: Extract<Question, { type: 'open_text' }>): string[] {
  const length = question.long ? t('types.open_text.long') : t('types.open_text.short')
  return question.max_chars === undefined ? [length] : [length, t('questionList.meta.upTo', { count: question.max_chars })]
}

function otherMeta(t: TFunction<'feedbackForms'>, question: Extract<Question, { type: 'statement' | 'consent' }>): string[] {
  if (question.type === 'statement') return [question.cta === undefined ? t('questionList.meta.textOnly') : t('questionList.meta.linkButton')]
  return [question.required ? t('consent.mustTick') : t('questionList.meta.optional')]
}

function ownMeta(t: TFunction<'feedbackForms'>, question: Question): string[] {
  switch (question.type) {
    case 'single_select': case 'multi_select': return choiceMeta(t, question)
    case 'open_text': return textMeta(t, question)
    case 'rating': case 'nps': case 'csat': case 'ces': return scaleMeta(t, question)
    case 'statement': case 'consent': return otherMeta(t, question)
    case 'contact_info': return CONTACT_FIELDS.filter((field) => question.fields[field].show).map((field) => t(`contact.fields.${field}`))
    case 'matrix': return [t('questionList.meta.rows', { count: question.rows.length }), t('questionList.meta.columns', { count: question.columns.length })]
  }
}

/** The card's meta line. */
export function cardMeta(t: TFunction<'feedbackForms'>, question: Question): string {
  const parts = ownMeta(t, question)
  const required = question.type !== 'consent' && question.type !== 'statement' && question.required
  return [...parts, ...(required ? [t('questionList.meta.required')] : [])].join(' · ')
}
