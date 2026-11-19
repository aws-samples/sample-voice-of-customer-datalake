/**
 * @fileoverview What is wrong with a question's rules (UX §5.5), rule by rule: a target that no longer exists or is
 * now earlier, a missing value, an option that was removed, a number outside the scale (errors, which block Save);
 * a `skipped` rule on a required question and a rule an earlier one always pre-empts (warnings); a rule that sends
 * everyone it catches where they would go without it (a note).
 *
 * @module pages/FeedbackForms/model/ruleProblems
 */
import type { FormV2, Question, Rule } from './formsV2'
import { isScale } from './formsV2'
import { textIn } from './i18nText'
import { matchesEverything, opTakesValue, opsFor, ruleCodes, scaleOf, scaleValues, splitOtherwise, valueCodes } from './rules'
import { noMatchTarget } from './paths'
import { sameJson } from '../../../lib/sameJson'

export type ProblemSeverity = 'error' | 'warning' | 'note'

export type RuleProblemCode =
  | 'targetMissingQuestion' | 'targetMissingEnding' | 'targetBackwards' | 'noValueOption' | 'noValueNumber'
  | 'optionRemoved' | 'outsideScale' | 'opInvalid' | 'skippedOnRequired' | 'ruleNeverRuns' | 'whereAnyway' | 'whereAnywayEnding'

export interface RuleProblem {
  readonly severity: ProblemSeverity
  readonly code: RuleProblemCode
  /** The rule's index in the question's logic (its Otherwise rules come last). */
  readonly ruleIndex: number
  readonly params: Readonly<Record<string, string | number>>
}

type Found = Omit<RuleProblem, 'ruleIndex'>

function targetProblem(form: FormV2, index: number, rule: Rule): Found | null {
  const target = rule.then.jump_to
  const at = form.questions.findIndex((question) => question.id === target)
  if (at === -1 && form.endings.some((ending) => ending.id === target)) return null
  if (at === -1) {
    return { severity: 'error', code: target.startsWith('end_') ? 'targetMissingEnding' : 'targetMissingQuestion', params: { target } }
  }
  if (at <= index) return { severity: 'error', code: 'targetBackwards', params: { number: at + 1, target } }
  return null
}

function scaleProblem(question: Question, value: Rule['when']['value']): Found | null {
  const scale = scaleOf(question)
  if (typeof value !== 'number') return { severity: 'error', code: 'noValueNumber', params: {} }
  if (scale === null || (value >= scale.min && value <= scale.max)) return null
  return { severity: 'error', code: 'outsideScale', params: { value, min: scale.min, max: scale.max } }
}

function valueProblem(question: Question, rule: Rule): Found | null {
  const { op, value } = rule.when
  if (!opsFor(question).includes(op)) {
    return op === 'skipped' && question.required
      ? { severity: 'warning', code: 'skippedOnRequired', params: {} }
      : { severity: 'error', code: 'opInvalid', params: { op } }
  }
  if (!opTakesValue(op)) return null
  if (isScale(question)) return scaleProblem(question, value)
  if (question.type === 'consent') return typeof value === 'boolean' ? null : { severity: 'error', code: 'noValueOption', params: {} }
  return codesProblem(question, value)
}

function codesProblem(question: Question, value: Rule['when']['value']): Found | null {
  const codes = valueCodes(value)
  if (codes.length === 0) return { severity: 'error', code: 'noValueOption', params: {} }
  const known = new Set(ruleCodes(question))
  const removed = codes.find((code) => !known.has(code))
  return removed === undefined ? null : { severity: 'error', code: 'optionRemoved', params: { code: removed } }
}

const sameCondition = (a: Rule, b: Rule): boolean => sameJson(a.when, b.when)

function shadowProblem(question: Question, rules: readonly Rule[], at: number): Found | null {
  const rule = rules[at]
  if (rule === undefined) return null
  const earlier = rules.slice(0, at).findIndex((before, index) => matchesEverything(question, before, rules[index + 1]) || sameCondition(before, rule))
  return earlier === -1 ? null : { severity: 'warning', code: 'ruleNeverRuns', params: { number: earlier + 1 } }
}

/** One answer as a rule reads it: an option code, a score, a consent's yes/no, true for any other answer, null for none. */
type Answer = string | number | boolean | null

/** Every answer a question of one of the listable types can be given (a typed text is just "answered"). */
function givenAnswers(question: Question): readonly Answer[] {
  if (question.type === 'single_select') return ruleCodes(question)
  if (isScale(question)) return scaleValues(question)
  return question.type === 'consent' ? [true, false] : [true]
}

/**
 * Every answer the question can get, or null when there are too many to list (a multiple choice: any set of its
 * options). Not answering is one of them unless the question is required or a statement (always "answered").
 */
function answersOf(question: Question): readonly Answer[] | null {
  if (question.type === 'multi_select') return null
  const given = givenAnswers(question)
  return question.required || question.type === 'statement' ? given : [...given, null]
}

const compares = (answer: Answer, value: Rule['when']['value'], test: (a: number, b: number) => boolean): boolean =>
  typeof answer === 'number' && typeof value === 'number' && test(answer, value)

/** Does `when` hold for `answer`, as the widget decides it (`ruleMatches`)? */
function holds(when: Rule['when'], answer: Answer): boolean {
  const { op, value } = when
  if (op === 'submitted') return answer !== null
  if (op === 'skipped') return answer === null
  if (answer === null) return false
  switch (op) {
    case 'equals': return answer === value
    case 'not_equals': return answer !== value
    case 'includes_any': return valueCodes(value).includes(String(answer))
    case 'includes_all': return valueCodes(value).every((code) => code === answer)
    case 'lt': return compares(answer, value, (a, b) => a < b)
    case 'lte': return compares(answer, value, (a, b) => a <= b)
    case 'gt': return compares(answer, value, (a, b) => a > b)
    case 'gte': return compares(answer, value, (a, b) => a >= b)
  }
}

/** Can one respondent's answer match both rules? Yes when unsure (a multiple choice: someone picks several options). */
function mayBothMatch(question: Question, a: Rule, b: Rule): boolean {
  const answers = answersOf(question)
  if (answers === null) return (a.when.op === 'skipped') === (b.when.op === 'skipped')
  return answers.some((answer) => holds(a.when, answer) && holds(b.when, answer))
}

/**
 * The note for an own rule that changes nothing, null when it matters. Without the rule, the respondents it catches
 * go to the first later rule that matches them, else where the question sends those no rule catches (its Otherwise,
 * else the next question). So the rule has no effect when its target is that last place and no later rule that could
 * catch one of the same respondents sends them elsewhere.
 */
function noEffectNote(form: FormV2, index: number, question: Question, rules: readonly Rule[], at: number): Found | null {
  const rule = rules[at]
  if (rule === undefined) return null
  const target = rule.then.jump_to
  if (target !== noMatchTarget(form, index)) return null
  const caughtElsewhere = rules.slice(at + 1).some((later) => later.then.jump_to !== target && mayBothMatch(question, rule, later))
  if (caughtElsewhere) return null
  const number = form.questions.findIndex((other) => other.id === target) + 1
  if (number > 0) return { severity: 'note', code: 'whereAnyway', params: { number } }
  return { severity: 'note', code: 'whereAnywayEnding', params: { title: textIn(form.endings.find((e) => e.id === target)?.title, form.language) } }
}

/** Every problem of the question at `index`'s rules (its Otherwise checked for its target only). */
export function ruleProblems(form: FormV2, index: number): RuleProblem[] {
  const question = form.questions[index]
  if (question === undefined) return []
  const logic = question.logic ?? []
  const { rules } = splitOtherwise(question)
  return logic.flatMap((rule, ruleIndex) => {
    const own = ruleIndex < rules.length
    const target = targetProblem(form, index, rule)
    const found: Found[] = target === null ? [] : [target]
    if (own) {
      const value = valueProblem(question, rule)
      const shadow = shadowProblem(question, rules, ruleIndex)
      // (a rule that never runs, or jumps nowhere valid, gets no "no effect" note on top)
      const note = target === null && shadow === null ? noEffectNote(form, index, question, rules, ruleIndex) : null
      found.push(...[value, shadow, note].filter((problem) => problem !== null))
    }
    return found.map((problem) => ({ ...problem, ruleIndex }))
  })
}
