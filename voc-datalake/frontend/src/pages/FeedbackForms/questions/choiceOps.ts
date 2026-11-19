/**
 * @fileoverview The choice editor's edits as pure functions (UX §4.1): adding options (a code made from the label),
 * a label edit that carries a fresh option's code along, pasting a list, and an option's "Go to" (one rule per
 * option: single choice `equals <code>`, multiple choice `includes_any [<code>]`).
 *
 * @module pages/FeedbackForms/questions/choiceOps
 */
import type { ChoiceOption, ChoiceQuestion, FormLanguage, FormV2, Rule } from '../model/formsV2'
import { LIMITS } from '../model/formsV2'
import { codeFromLabel } from '../model/codes'
import { textIn, textOf, withText } from '../model/i18nText'
import { renameOptionCode, updateChoice } from '../model/mutations'
import { splitOtherwise, valueCodes, withLogic } from '../model/rules'

/** The key of a fresh option in the draft's `freshCodes`. */
export const freshKey = (questionId: string, code: string): string => `${questionId}:${code}`

const takenCodes = (question: ChoiceQuestion, except?: string): Set<string> =>
  new Set(question.options.map((o) => o.code).filter((code) => code !== except))

/** `question` with new options (from `labels`) inserted at `at`; their codes, made from the labels. */
export function withNewOptions(question: ChoiceQuestion, at: number, labels: readonly string[], language: FormLanguage): { question: ChoiceQuestion; codes: string[] } {
  const room = Math.max(0, LIMITS.options - question.options.length)
  const taken = takenCodes(question)
  const added: ChoiceOption[] = labels.slice(0, room).map((label) => {
    const code = codeFromLabel(label, taken)
    taken.add(code)
    return { code, label: textOf(language, label) }
  })
  const options = [...question.options.slice(0, at), ...added, ...question.options.slice(at)]
  return { question: { ...question, options }, codes: added.map((option) => option.code) }
}

/**
 * The form with option `code`'s label set to `label`. A fresh option's code follows its label (and the rules that name
 * it): the new code is returned, so the caller can move its "fresh" mark.
 */
export function withOptionLabel(form: FormV2, questionId: string, code: string, label: string, fresh: boolean): { form: FormV2; code: string } {
  const question = form.questions.find((q) => q.id === questionId)
  if (question === undefined || (question.type !== 'single_select' && question.type !== 'multi_select')) return { form, code }
  const next = fresh ? codeFromLabel(label, takenCodes(question, code)) : code
  const renamed = next === code ? form : renameOptionCode(form, questionId, code, next)
  const labelled = updateChoice(renamed, questionId, (q) => ({
    ...q, options: q.options.map((o) => (o.code === next ? { ...o, label: withText(o.label, form.language, label) } : o)),
  }))
  return { form: labelled, code: next }
}

export interface PastedList {
  readonly labels: readonly string[]
  readonly duplicates: number
  readonly blanks: number
}

/** One option per line: blank lines ignored, a line repeated (or already an option) skipped. */
export function parsePastedList(text: string, existing: readonly string[]): PastedList {
  const lines = text.split(/\r?\n/)
  const seen = new Set(existing.map((label) => label.trim().toLowerCase()))
  const labels: string[] = []
  const counts = { duplicates: 0, blanks: 0 }
  for (const line of lines) {
    const label = line.trim()
    if (label === '') counts.blanks += 1
    else if (seen.has(label.toLowerCase())) counts.duplicates += 1
    else {
      seen.add(label.toLowerCase())
      labels.push(label)
    }
  }
  // (a final newline is not a blank line someone typed)
  const trailing = lines.at(-1)?.trim() === '' ? 1 : 0
  return { labels, duplicates: counts.duplicates, blanks: Math.max(0, counts.blanks - trailing) }
}

/** The labels of a question's options in a language. */
export const optionLabels = (question: ChoiceQuestion, language: FormLanguage): string[] =>
  question.options.map((option) => textIn(option.label, language))

/** How an option jumps: no rule, its own rule (to `target`), or a broader rule in Logic that names it. */
export type OptionJump =
  | { readonly kind: 'none' }
  | { readonly kind: 'own'; readonly target: string }
  | { readonly kind: 'broader' }

const isOwnRule = (question: ChoiceQuestion, rule: Rule, code: string): boolean => {
  if (question.type === 'single_select') return rule.when.op === 'equals' && rule.when.value === code
  const codes = valueCodes(rule.when.value)
  return rule.when.op === 'includes_any' && codes.length === 1 && codes[0] === code
}

export function optionJump(question: ChoiceQuestion, code: string): OptionJump {
  const { rules } = splitOtherwise(question)
  const own = rules.find((rule) => isOwnRule(question, rule, code))
  if (own !== undefined) return { kind: 'own', target: own.then.jump_to }
  return rules.some((rule) => valueCodes(rule.when.value).includes(code)) ? { kind: 'broader' } : { kind: 'none' }
}

/** `question` with option `code`'s own rule set to jump to `target`, or removed (null: the default path). */
export function withOptionJump(question: ChoiceQuestion, code: string, target: string | null): ChoiceQuestion {
  const { rules, otherwise } = splitOtherwise(question)
  const at = rules.findIndex((rule) => isOwnRule(question, rule, code))
  const value = question.type === 'single_select' ? code : [code]
  const op = question.type === 'single_select' ? 'equals' : 'includes_any'
  const own: Rule | null = target === null ? null : { when: { op, value }, then: { jump_to: target } }
  const kept = rules.filter((_rule, index) => index !== at)
  if (own === null) return withLogic(question, kept, otherwise)
  const next = at === -1 ? [...rules, own] : rules.map((rule, index) => (index === at ? own : rule))
  return withLogic(question, next, otherwise)
}
