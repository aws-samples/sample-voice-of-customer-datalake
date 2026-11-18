/**
 * @fileoverview A question's logic (contract `Rule`, UX §5): which operators each type offers, the scale a number
 * rule compares with, and how "Otherwise" is stored without a contract field (UX §5.3, D1).
 *
 * "Otherwise → X" is written as the question's LAST rule(s): `{op: submitted} → X` for a required question or a
 * statement, plus `{op: skipped} → X` for an optional one. On load, such a trailing rule (or pair, same target) reads
 * back as Otherwise; anything else stays an ordinary rule. The round trip is lossless.
 *
 * @module pages/FeedbackForms/model/rules
 */
import type { Question, Rule, RuleOp, RuleValue } from './formsV2'
import { isChoice, isScale } from './formsV2'

/** The operators a question's type offers (UX §5.1), in the order the Logic section lists them. */
const SCALE_OPS: readonly RuleOp[] = ['lte', 'gte', 'equals', 'not_equals', 'lt', 'gt']
const VALUE_OPS: Readonly<Record<Question['type'], readonly RuleOp[]>> = {
  single_select: ['equals', 'not_equals', 'includes_any'],
  multi_select: ['includes_any', 'includes_all'],
  rating: SCALE_OPS, nps: SCALE_OPS, csat: SCALE_OPS, ces: SCALE_OPS,
  consent: ['equals'],
  open_text: [], contact_info: [], statement: [],
}

/** The operators a question's type offers (UX §5.1), in the order the Logic section lists them. */
export function opsFor(question: Question): readonly RuleOp[] {
  // `skipped` only for an optional question (a required one is never skipped); a statement only "Then go to".
  const skippable = !question.required && question.type !== 'statement'
  return [...VALUE_OPS[question.type], 'submitted', ...(skippable ? ['skipped' as const] : [])]
}

/** Does `op` need a value? */
export const opTakesValue = (op: RuleOp): boolean => op !== 'submitted' && op !== 'skipped'

/** Does `op` take several option codes? */
export const opTakesCodes = (op: RuleOp): boolean => op === 'includes_any' || op === 'includes_all'

/** The most likely operator for a new rule (UX §5.2): choice "is", numbers "is at most". */
export function defaultOp(question: Question): RuleOp {
  if (question.type === 'multi_select') return 'includes_any'
  if (isScale(question)) return 'lte'
  const [first] = opsFor(question)
  return first ?? 'submitted'
}

/** The inclusive range of a scale question, or null for a question without one. */
export function scaleOf(question: Question): { readonly min: number; readonly max: number } | null {
  switch (question.type) {
    case 'rating': return { min: 1, max: question.range }
    case 'nps': return { min: 0, max: 10 }
    case 'csat': return { min: 1, max: 5 }
    case 'ces': return { min: 1, max: 7 }
    default: return null
  }
}

/** The values a scale offers, low to high. */
export function scaleValues(question: Question): number[] {
  const scale = scaleOf(question)
  return scale === null ? [] : Array.from({ length: scale.max - scale.min + 1 }, (_unused, index) => scale.min + index)
}

/** The option codes a rule's value can name on this question: its options, then `other` and `none` when on. */
export function ruleCodes(question: Question): string[] {
  if (!isChoice(question)) return []
  const extra = [question.other.enabled ? 'other' : null, question.type === 'multi_select' && question.none.enabled ? 'none' : null]
  return [...question.options.map((option) => option.code), ...extra.filter((code) => code !== null)]
}

/** A rule's value as a list of codes (a single code is a list of one). */
export function valueCodes(value: RuleValue | undefined): readonly string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : []
}

/** The rule of a question split into its own rules and its Otherwise target (null: the next question). */
export interface SplitLogic {
  readonly rules: readonly Rule[]
  readonly otherwise: string | null
}

const isOp = (rule: Rule | undefined, op: RuleOp): boolean => rule?.when.op === op

/** How many trailing rules make the Otherwise for `question`, or 0 when its logic does not end in one. */
function otherwiseLength(question: Question, logic: readonly Rule[]): number {
  const last = logic.at(-1)
  const beforeLast = logic.at(-2)
  if (last === undefined) return 0
  if (question.required || question.type === 'statement') return isOp(last, 'submitted') ? 1 : 0
  const pair = beforeLast?.then.jump_to === last.then.jump_to
    && ((isOp(beforeLast, 'submitted') && isOp(last, 'skipped')) || (isOp(beforeLast, 'skipped') && isOp(last, 'submitted')))
  return pair ? 2 : 0
}

/** The question's rules and its Otherwise, read from its stored logic (UX §5.3). */
export function splitOtherwise(question: Question): SplitLogic {
  const logic = question.logic ?? []
  const length = otherwiseLength(question, logic)
  if (length === 0) return { rules: logic, otherwise: null }
  const target = logic.at(-1)?.then.jump_to ?? null
  return { rules: logic.slice(0, logic.length - length), otherwise: target }
}

/** The stored logic for `rules` and an Otherwise target (null: none, the form goes to the next question). */
export function joinOtherwise(question: Question, rules: readonly Rule[], otherwise: string | null): Rule[] {
  if (otherwise === null) return [...rules]
  const submitted: Rule = { when: { op: 'submitted' }, then: { jump_to: otherwise } }
  const skipped: Rule = { when: { op: 'skipped' }, then: { jump_to: otherwise } }
  const encoded = question.required || question.type === 'statement' ? [submitted] : [submitted, skipped]
  return [...rules, ...encoded]
}

/** `question` with its logic rewritten from rules and an Otherwise (an empty logic is dropped). */
export function withLogic<Q extends Question>(question: Q, rules: readonly Rule[], otherwise: string | null): Q {
  const logic = joinOtherwise(question, rules, otherwise)
  return { ...question, logic: logic.length === 0 ? undefined : logic }
}

/** Does this rule match every answer (so nothing after it ever runs, and the form never falls through)? */
export function matchesEverything(question: Question, rule: Rule, next: Rule | undefined): boolean {
  if (rule.when.op !== 'submitted') return false
  if (question.required || question.type === 'statement') return true
  return next?.when.op === 'skipped'
}
