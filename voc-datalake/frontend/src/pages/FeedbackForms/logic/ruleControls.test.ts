/**
 * A rule row's controls (UX §5.1): the operators a question offers (a consent's accepted / not accepted, its
 * `submitted` / `skipped`), always within the ops the server takes (schemas/form-logic-ops.json), the value a rule
 * keeps when its operator changes, and the targets its "go to" lists.
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import logicOps from '../../../../../schemas/form-logic-ops.json'
import type { Question, QuestionType, Rule } from '../model/formsV2'
import { RULE_OPS } from '../model/formsV2'
import { newQuestion } from '../model/defaults'
import { sampleForm } from '../test/draftHarness'
import { defined } from '../../../test/defined'
import { choiceKey, fallthroughLabel, opChoices, otherwiseValue, scoreLabel, targetGroups, withChoice } from './ruleControls'

const t = i18n.getFixedT('en', 'feedbackForms')

const consent: Question = { id: 'q_ok', type: 'consent', headline: { en: 'May we contact you?' }, required: false, label: { en: 'Yes' } }
const reason: Question = { ...newQuestion('single_select', 'q_reason'), headline: { en: 'Why?' } }
const nps: Question = {
  id: 'q_nps', type: 'nps', headline: { en: 'Recommend us?' }, required: true,
  lower_label: { en: 'Not at all likely' }, upper_label: { en: 'Extremely likely' },
}
const when = (op: Rule['when']['op'], value?: Rule['when']['value']): Rule => ({ when: { op, value }, then: { jump_to: 'end_thanks' } })
const choiceOf = (question: Question, key: string) => defined(opChoices(t, question).find((choice) => choice.key === key), key)

const FORM = sampleForm({
  questions: [reason, nps, { ...newQuestion('open_text', 'q_more'), headline: { en: 'Tell us more' } }],
  endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }, { id: 'end_bye', title: { en: 'Bye' } }],
})

describe('opChoices and choiceKey', () => {
  it("reads a consent's two choices, accepted and not accepted, as its submitted and skipped", () => {
    expect(opChoices(t, consent).map((choice) => [choice.key, choice.op, choice.label])).toStrictEqual([
      ['accepted', 'submitted', 'is accepted'], ['notAccepted', 'skipped', 'is not accepted'],
    ])
  })

  it('offers a required consent only accepted: it is never left unticked', () => {
    expect(opChoices(t, { ...consent, required: true }).map((choice) => choice.key)).toStrictEqual(['accepted'])
  })

  it('offers a choice question its operators by name', () => {
    expect(opChoices(t, reason).map((choice) => choice.label)).toStrictEqual(['is', 'is not', 'is one of', 'is answered'])
  })

  it('selects a consent rule by what it means (a legacy `equals true / false` too), any other rule by its operator', () => {
    expect([when('submitted'), when('skipped')].map((rule) => choiceKey(consent, rule))).toStrictEqual(['accepted', 'notAccepted'])
    expect(choiceKey(consent, when('equals', false))).toBe('notAccepted')
    expect(choiceKey(consent, when('equals', true))).toBe('accepted')
    expect(choiceKey(reason, when('not_equals', 'price'))).toBe('not_equals')
  })
})

describe('the choices stay within the ops the server takes (schemas/form-logic-ops.json)', () => {
  const SERVER: Readonly<Record<QuestionType, readonly string[]>> = logicOps.ops_by_type
  const TYPES: readonly QuestionType[] = ['single_select', 'multi_select', 'open_text', 'rating', 'nps', 'csat', 'ces', 'statement', 'consent', 'contact_info']

  it('names every question type the builder has, and only ops a rule can hold', () => {
    const sorted = (types: readonly string[]) => [...types].sort((a, b) => a.localeCompare(b))
    expect(sorted(Object.keys(SERVER))).toStrictEqual(sorted(TYPES))
    expect(Object.values(SERVER).flat().filter((op) => !RULE_OPS.some((known) => known === op))).toStrictEqual([])
  })

  it.each(TYPES.map((type) => [type]))('offers a %s question, required or not, only what the server takes', (type) => {
    const offered = [true, false].flatMap((required) => opChoices(t, { ...newQuestion(type, 'q_x'), required }).map((choice) => choice.op))
    expect(offered.filter((op) => !SERVER[type].includes(op))).toStrictEqual([])
  })
})

describe('withChoice', () => {
  it('writes a consent choice as submitted or skipped (a legacy rule too), and drops the value of "is answered"', () => {
    const submitted = choiceOf(reason, 'submitted')
    expect(withChoice(consent, when('equals', true), choiceOf(consent, 'notAccepted'))).toStrictEqual({ when: { op: 'skipped' }, then: { jump_to: 'end_thanks' } })
    expect(withChoice(consent, when('equals', false), choiceOf(consent, 'accepted'))).toStrictEqual({ when: { op: 'submitted' }, then: { jump_to: 'end_thanks' } })
    expect(withChoice(reason, when('equals', 'price'), submitted)).toStrictEqual({ when: { op: 'submitted' }, then: { jump_to: 'end_thanks' } })
  })

  it('keeps a score across scale operators, and drops what is not a score', () => {
    const atLeast = choiceOf(nps, 'gte')
    expect(withChoice(nps, when('lte', 6), atLeast).when).toStrictEqual({ op: 'gte', value: 6 })
    expect(withChoice(nps, when('submitted'), atLeast).when).toStrictEqual({ op: 'gte' })
  })

  it('makes a code a list of one, and a list its first code', () => {
    const oneOf = choiceOf(reason, 'includes_any')
    const is = choiceOf(reason, 'equals')
    expect(withChoice(reason, when('equals', 'price'), oneOf).when).toStrictEqual({ op: 'includes_any', value: ['price'] })
    expect(withChoice(reason, when('includes_any', ['bugs', 'price']), is).when).toStrictEqual({ op: 'equals', value: 'bugs' })
    expect(withChoice(reason, when('includes_any', []), is).when).toStrictEqual({ op: 'equals' })
  })
})

describe('targetGroups', () => {
  it('lists the next question, the later ones and the endings, never an earlier one', () => {
    const groups = targetGroups(t, FORM, 0, null)
    expect(groups.next).toStrictEqual([{ value: 'q_nps', label: '2 · Recommend us?' }])
    expect(groups.later).toStrictEqual([{ value: 'q_more', label: '3 · Tell us more' }])
    expect(groups.endings.map((option) => option.label)).toStrictEqual(['Ending: Thank you!', 'Ending: Bye'])
    expect(groups.invalid).toBeNull()
  })

  it('keeps a target that is no longer offered so the select still shows it', () => {
    expect(targetGroups(t, FORM, 1, 'q_reason').invalid).toStrictEqual({ value: 'q_reason', label: '1 · Why?' })
    expect(targetGroups(t, FORM, 1, 'q_gone').invalid).toStrictEqual({ value: 'q_gone', label: 'a deleted question or ending' })
  })

  it('leaves out the target the Otherwise already takes', () => {
    const groups = targetGroups(t, FORM, 0, 'q_nps', 'q_nps')
    expect([groups.next, groups.invalid]).toStrictEqual([[], null])
    expect(targetGroups(t, FORM, 2, null, 'end_bye').endings).toStrictEqual([{ value: 'end_thanks', label: 'Ending: Thank you!' }])
  })
})

describe('the Otherwise select', () => {
  it('names the next question, or the default ending on the last question', () => {
    expect(fallthroughLabel(t, FORM, 0)).toBe('Next question: 2 · Recommend us?')
    expect(fallthroughLabel(t, FORM, 2)).toBe('End: Thank you!')
    expect(fallthroughLabel(t, { ...FORM, endings: [] }, 2)).toBe('End: ')
  })

  it('reads no jump, and a jump to where the form goes anyway, as the first entry', () => {
    expect(otherwiseValue(FORM, 0, null)).toBe('')
    expect(otherwiseValue(FORM, 0, 'q_nps')).toBe('')
    expect(otherwiseValue(FORM, 0, 'end_bye')).toBe('end_bye')
  })
})

describe('scoreLabel', () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('puts the end labels beside the two ends of a scale', () => {
    expect(scoreLabel(t, FORM, nps, 0, values)).toBe('0 — Not at all likely')
    expect(scoreLabel(t, FORM, nps, 10, values)).toBe('10 — Extremely likely')
    expect(scoreLabel(t, FORM, nps, 6, values)).toBe('6')
  })

  it('says a number alone for a question without a scale', () => {
    expect(scoreLabel(t, FORM, reason, 3, values)).toBe('3')
  })
})
