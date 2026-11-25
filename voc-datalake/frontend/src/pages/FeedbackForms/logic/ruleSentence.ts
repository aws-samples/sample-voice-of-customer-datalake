/**
 * @fileoverview A rule as the sentence people read back (UX §5.1): "If the answer is “It's too expensive” →
 * 2 · What could have kept you?", and "Otherwise → 7 · …". The editor's controls make the same sentence; this is its
 * read-only form (Flow, the picker's preview, a card's tooltip, the AI diff, the assistant's card).
 *
 * Option values read as their labels in the form's primary language (never the codes); Other and None by their
 * names; numbers as numbers; a consent as accepted / not accepted.
 *
 * @module pages/FeedbackForms/logic/ruleSentence
 */
import type { TFunction } from 'i18next'
import type { FormV2, Question, Rule } from '../model/formsV2'
import { isChoice } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { headlineShown } from '../model/recall'
import { consentOp, splitOtherwise, valueCodes } from '../model/rules'

/** An option code as it reads: its label, or "Other (typed answer)" / "None of these". */
export function codeLabel(t: TFunction<'feedbackForms'>, form: FormV2, question: Question, code: string): string {
  if (code === 'other') return t('logic.values.other')
  if (code === 'none') return t('logic.values.none')
  const option = isChoice(question) ? question.options.find((o) => o.code === code) : undefined
  const label = option === undefined ? '' : textIn(option.label, form.language)
  return label === '' ? code : label
}

const quoted = (t: TFunction<'feedbackForms'>, text: string): string => t('logic.values.quoted', { text })

/**
 * The operator's words for this question ("is", "includes any of", "is at most"…; a consent's `submitted` "is
 * accepted", its `skipped` "is not accepted", as a legacy `equals true / false` reads too).
 */
export function opText(t: TFunction<'feedbackForms'>, question: Question, op: Rule['when']['op'], value?: Rule['when']['value']): string {
  const consent = question.type === 'consent' ? consentOp(op, value) : null
  if (consent === 'submitted') return t('logic.ops.accepted')
  if (consent === 'skipped') return t('logic.ops.notAccepted')
  if (op === 'includes_any') return question.type === 'multi_select' ? t('logic.ops.includesAnyMulti') : t('logic.ops.includesAnySingle')
  return t(`logic.ops.${op}`)
}

/** "is “It's too expensive”", "is at most 6", "is not accepted", "is answered". */
export function conditionText(t: TFunction<'feedbackForms'>, form: FormV2, question: Question, rule: Rule): string {
  const { op, value } = rule.when
  const words = opText(t, question, op, value)
  if (question.type === 'consent' || op === 'submitted' || op === 'skipped' || value === undefined) return words
  if (typeof value === 'number') return `${words} ${String(value)}`
  const labels = valueCodes(value).map((code) => quoted(t, codeLabel(t, form, question, code)))
  return `${words} ${labels.join(t('logic.values.separator'))}`
}

/** Where a jump goes: "2 · What could have kept you?", "Ending: Thank you", or "a deleted question". */
export function targetText(t: TFunction<'feedbackForms'>, form: FormV2, target: string): string {
  const at = form.questions.findIndex((q) => q.id === target)
  const question = form.questions[at]
  if (question !== undefined) return t('logic.target.question', { number: at + 1, headline: headlineShown(question.headline, form.language) })
  const ending = form.endings.find((e) => e.id === target)
  if (ending !== undefined) return t('logic.target.ending', { title: headlineShown(ending.title, form.language) })
  return t('logic.target.missing')
}

/** "If the answer is “It's too expensive” → 2 · What could have kept you?" */
export function ruleSentence(t: TFunction<'feedbackForms'>, form: FormV2, question: Question, rule: Rule): string {
  return t('logic.sentence.rule', { condition: conditionText(t, form, question, rule), target: targetText(t, form, rule.then.jump_to) })
}

/** Every rule of a question as a sentence, then its "Otherwise → …" when it has one. */
export function logicSentences(t: TFunction<'feedbackForms'>, form: FormV2, question: Question): string[] {
  const { rules, otherwise } = splitOtherwise(question)
  const lines = rules.map((rule) => ruleSentence(t, form, question, rule))
  return otherwise === null ? lines : [...lines, t('logic.sentence.otherwise', { target: targetText(t, form, otherwise) })]
}
