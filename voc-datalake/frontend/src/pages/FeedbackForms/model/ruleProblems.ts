/**
 * @fileoverview What is wrong with a question's rules (UX §5.5), rule by rule: a target that no longer exists or is
 * now earlier, a missing value, an option that was removed, a number outside the scale (errors, which block Save);
 * a `skipped` rule on a required question and a rule an earlier one always pre-empts (warnings); a rule that goes
 * where the form goes anyway (a note).
 *
 * @module pages/FeedbackForms/model/ruleProblems
 */
import type { FormV2, Question, Rule } from './formsV2'
import { isScale } from './formsV2'
import { matchesEverything, opTakesValue, opsFor, ruleCodes, scaleOf, splitOtherwise, valueCodes } from './rules'
import { fallthroughTarget } from './paths'
import { sameJson } from '../../../lib/sameJson'

export type ProblemSeverity = 'error' | 'warning' | 'note'

export type RuleProblemCode =
  | 'targetMissingQuestion' | 'targetMissingEnding' | 'targetBackwards' | 'noValueOption' | 'noValueNumber'
  | 'optionRemoved' | 'outsideScale' | 'opInvalid' | 'skippedOnRequired' | 'ruleNeverRuns' | 'whereAnyway'

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

/** Every problem of the question at `index`'s rules (its Otherwise checked for its target only). */
export function ruleProblems(form: FormV2, index: number): RuleProblem[] {
  const question = form.questions[index]
  if (question === undefined) return []
  const logic = question.logic ?? []
  const { rules } = splitOtherwise(question)
  const fallthrough = fallthroughTarget(form, index)
  return logic.flatMap((rule, ruleIndex) => {
    const own = ruleIndex < rules.length
    const target = targetProblem(form, index, rule)
    const found: Found[] = target === null ? [] : [target]
    if (own) {
      const value = valueProblem(question, rule)
      const shadow = shadowProblem(question, rules, ruleIndex)
      found.push(...[value, shadow].filter((problem) => problem !== null))
      if (target === null && rule.then.jump_to === fallthrough) found.push({ severity: 'note', code: 'whereAnyway', params: {} })
    }
    return found.map((problem) => ({ ...problem, ruleIndex }))
  })
}
