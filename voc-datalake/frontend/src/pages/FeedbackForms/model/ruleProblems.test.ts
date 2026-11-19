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

describe('ruleProblems: an op the server does not take, and a consent\'s two rules', () => {
  const consent = (required: boolean, logic: readonly Rule[]): Question => ({
    id: 'q_ok', type: 'consent', headline: { en: 'May we contact you?' }, required, label: { en: 'Yes' }, logic,
  })
  const problemsOf = (first: Question) => ruleProblems(formOf(first), 0).map((problem) => [problem.severity, problem.code, problem.ruleIndex])

  it('refuses, as an error, an op the server refuses for the type (schemas/form-logic-ops.json)', () => {
    // (a consent's `equals`, as the templates once wrote it; a comparison on an open text; a statement's skipped)
    expect(problemsOf(consent(false, [rule('equals', false, 'end_thanks')]))).toStrictEqual([['error', 'opInvalid', 0]])
    expect(problemsOf({ ...text('q_more'), logic: [rule('gte', 3, 'end_thanks')] })).toStrictEqual([['error', 'opInvalid', 0]])
    const statement: Question = { id: 'q_note', type: 'statement', headline: { en: 'Thanks' }, required: false, logic: [rule('skipped', undefined, 'end_thanks')] }
    expect(problemsOf(statement)).toStrictEqual([['error', 'opInvalid', 0]])
  })

  it('takes accepted → one place and not accepted → another, neither pre-empting the other', () => {
    const form = formOf(consent(false, [rule('submitted', undefined, 'q_task'), rule('skipped', undefined, 'end_thanks')]))
    expect(ruleProblems(form, 0)).toStrictEqual([])
  })

  it('still says a rule after both never runs, and warns of not accepted on a consent that must be ticked', () => {
    const after = formOf(consent(false, [rule('submitted', undefined, 'q_task'), rule('skipped', undefined, 'end_thanks'), rule('skipped', undefined, 'q_missing')]))
    expect(ruleProblems(after, 0).map((problem) => [problem.code, problem.ruleIndex])).toStrictEqual([['ruleNeverRuns', 2]])
    expect(problemsOf(consent(true, [rule('skipped', undefined, 'end_thanks')]))).toStrictEqual([['warning', 'skippedOnRequired', 0]])
  })
})
