import { describe, expect, it } from 'vitest'
import type { ChoiceQuestion, FormV2, Question, Rule } from './formsV2'
import { noMatchTarget } from './paths'
import { ruleProblems } from './ruleProblems'
import { sampleForm } from '../test/draftHarness'

const choice = (type: ChoiceQuestion['type'], logic: readonly Rule[]): ChoiceQuestion => ({
  id: 'q_why', type, headline: { en: 'Why did you switch back?' }, required: true, logic,
  options: [{ code: 'missing', label: { en: 'A function is missing' } }, { code: 'slow', label: { en: 'It is slow' } }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
})
const text = (id: string): Question => ({ id, type: 'open_text', headline: { en: id }, required: false, long: true, input_type: 'text' })
const rule = (op: Rule['when']['op'], value: Rule['when']['value'], to: string): Rule =>
  (value === undefined ? { when: { op }, then: { jump_to: to } } : { when: { op, value }, then: { jump_to: to } })

const formOf = (first: Question): FormV2 => sampleForm({ questions: [first, text('q_missing'), text('q_task')] })
const notes = (form: FormV2) => ruleProblems(form, 0).filter((problem) => problem.severity === 'note')

describe('ruleProblems: a rule with no effect (the "goes there anyway" note)', () => {
  it('stays quiet when the Otherwise sends everyone else elsewhere: the rule is the only way into its target', () => {
    // (the pilot's flow: "includes A function is missing → 2", Otherwise → 3)
    const form = formOf(choice('multi_select', [rule('includes_any', ['missing'], 'q_missing'), rule('submitted', undefined, 'q_task')]))
    expect(noMatchTarget(form, 0)).toBe('q_task')
    expect(notes(form)).toStrictEqual([])
  })

  it('notes a rule that goes where the Otherwise sends everyone anyway, naming that question', () => {
    const form = formOf(choice('single_select', [rule('equals', 'slow', 'q_task'), rule('submitted', undefined, 'q_task')]))
    expect(notes(form)).toStrictEqual([{ severity: 'note', code: 'whereAnyway', ruleIndex: 0, params: { number: 3 } }])
  })

  it('notes a rule to the next question when there is no Otherwise', () => {
    const form = formOf(choice('single_select', [rule('equals', 'missing', 'q_missing')]))
    expect(noMatchTarget(form, 0)).toBe('q_missing')
    expect(notes(form)).toStrictEqual([{ severity: 'note', code: 'whereAnyway', ruleIndex: 0, params: { number: 2 } }])
  })

  it('stays quiet when a later rule could catch the same respondents and send them elsewhere', () => {
    // (someone who ticks both options: without rule 1, rule 2 would end the form for them)
    const form = formOf(choice('multi_select', [rule('includes_any', ['missing'], 'q_missing'), rule('includes_any', ['slow'], 'end_thanks')]))
    expect(notes(form)).toStrictEqual([])
  })

  it('still notes it when a later rule can never catch the same answer (one choice, another option)', () => {
    const form = formOf(choice('single_select', [rule('equals', 'missing', 'q_missing'), rule('equals', 'slow', 'end_thanks')]))
    expect(notes(form).map((problem) => problem.ruleIndex)).toStrictEqual([0])
  })

  it('names the ending when the last question’s rule ends the form where it would end anyway', () => {
    const form = sampleForm({ questions: [choice('single_select', [rule('equals', 'slow', 'end_thanks')])] })
    expect(notes(form)).toStrictEqual([{ severity: 'note', code: 'whereAnywayEnding', ruleIndex: 0, params: { title: 'Thank you!' } }])
  })
})
