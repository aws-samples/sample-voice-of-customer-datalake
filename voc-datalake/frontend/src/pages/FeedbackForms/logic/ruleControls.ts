/**
 * @fileoverview What a rule row's controls offer (UX §5.1): the operator choices of a question (a consent's `equals`
 * reads as two, "is accepted" and "is not accepted"), the value a rule keeps when its operator changes, and the
 * targets its "go to" lists (the next question, the later ones, the endings; never an earlier one).
 *
 * @module pages/FeedbackForms/logic/ruleControls
 */
import type { TFunction } from 'i18next'
import type { FormV2, Question, Rule, RuleOp } from '../model/formsV2'
import { isScale } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { opTakesCodes, opTakesValue, opsFor, valueCodes } from '../model/rules'
import { fallthroughTarget } from '../model/paths'
import { opText, targetText } from './ruleSentence'

/** One entry of the operator select: an operator, and for a consent the yes/no it compares with. */
export interface OpChoice {
  readonly key: string
  readonly op: RuleOp
  readonly consent?: boolean
  readonly label: string
}

export function opChoices(t: TFunction<'feedbackForms'>, question: Question): OpChoice[] {
  return opsFor(question).flatMap((op): OpChoice[] => {
    if (question.type === 'consent' && op === 'equals') {
      return [
        { key: 'accepted', op, consent: true, label: opText(t, question, op, true) },
        { key: 'notAccepted', op, consent: false, label: opText(t, question, op, false) },
      ]
    }
    return [{ key: op, op, label: opText(t, question, op) }]
  })
}

/** The operator select's value for `rule`. */
export function choiceKey(question: Question, rule: Rule): string {
  if (question.type === 'consent' && rule.when.op === 'equals') return rule.when.value === false ? 'notAccepted' : 'accepted'
  return rule.when.op
}

/** `rule` with the operator `choice`, keeping what of its value still fits (a code becomes a list of one…). */
export function withChoice(question: Question, rule: Rule, choice: OpChoice): Rule {
  const old = rule.when.value
  const then = rule.then
  if (choice.consent !== undefined) return { when: { op: choice.op, value: choice.consent }, then }
  if (!opTakesValue(choice.op)) return { when: { op: choice.op }, then }
  if (isScale(question)) return typeof old === 'number' ? { when: { op: choice.op, value: old }, then } : { when: { op: choice.op }, then }
  const codes = valueCodes(old)
  if (opTakesCodes(choice.op)) return { when: { op: choice.op, value: codes }, then }
  const [first] = codes
  return first === undefined ? { when: { op: choice.op }, then } : { when: { op: choice.op, value: first }, then }
}

interface TargetOption {
  readonly value: string
  readonly label: string
}

export interface TargetGroups {
  readonly next: readonly TargetOption[]
  readonly later: readonly TargetOption[]
  readonly endings: readonly TargetOption[]
  /** The current target when it is not one of the above (deleted, or now earlier): kept so the select shows it. */
  readonly invalid: TargetOption | null
}

const questionOption = (t: TFunction<'feedbackForms'>, form: FormV2, at: number): TargetOption[] => {
  const question = form.questions[at]
  return question === undefined ? [] : [{ value: question.id, label: t('logic.target.question', { number: at + 1, headline: textIn(question.headline, form.language) }) }]
}

/** The targets a rule of the question at `index` can go to, grouped as its select lists them. */
export function targetGroups(t: TFunction<'feedbackForms'>, form: FormV2, index: number, current: string | null, skip: string | null = null): TargetGroups {
  const later = form.questions.slice(index + 1).map((_q, offset) => index + 1 + offset)
  const nextIndex = later[0]
  const next = nextIndex === undefined ? [] : questionOption(t, form, nextIndex)
  const rest = later.slice(1).flatMap((at) => questionOption(t, form, at))
  const endings = form.endings.map((ending) => ({ value: ending.id, label: t('logic.target.ending', { title: textIn(ending.title, form.language) }) }))
  const all = [...next, ...rest, ...endings].filter((option) => option.value !== skip)
  const known = current === null || all.some((option) => option.value === current) || current === skip
  return {
    next: next.filter((option) => option.value !== skip),
    later: rest.filter((option) => option.value !== skip),
    endings: endings.filter((option) => option.value !== skip),
    invalid: known ? null : { value: current, label: targetText(t, form, current) },
  }
}

/** The Otherwise select's first entry: "Next question: 2 · …", or "End: Thank you!" on the last question. */
export function fallthroughLabel(t: TFunction<'feedbackForms'>, form: FormV2, index: number): string {
  const next = form.questions[index + 1]
  if (next !== undefined) return t('logic.target.nextNumbered', { number: index + 2, headline: textIn(next.headline, form.language) })
  const ending = form.endings[0]
  return t('logic.target.defaultEnding', { title: ending === undefined ? '' : textIn(ending.title, form.language) })
}

/** The Otherwise target as the select shows it: '' for "no jump" (or a jump to where the form goes anyway). */
export function otherwiseValue(form: FormV2, index: number, otherwise: string | null): string {
  return otherwise === null || otherwise === fallthroughTarget(form, index) ? '' : otherwise
}

/** A score as the value select lists it: the end labels beside the two ends ("6", "0 — Not at all likely"). */
export function scoreLabel(t: TFunction<'feedbackForms'>, form: FormV2, question: Question, value: number, values: readonly number[]): string {
  if (!isScale(question)) return String(value)
  const end = value === values[0] ? question.lower_label : undefined
  const label = textIn(value === values.at(-1) ? question.upper_label : end, form.language)
  return label === '' ? String(value) : t('logic.numberWithLabel', { value, label })
}
