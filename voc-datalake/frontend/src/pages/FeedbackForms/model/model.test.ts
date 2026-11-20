import { describe, expect, it } from 'vitest'
import { codeFromLabel, duplicateId, foldAccents, isReservedCode, newQuestionId, slugOf, uniqueSlug } from './codes'
import { defaultOp, joinOtherwise, opsFor, scaleValues, splitOtherwise, withLogic } from './rules'
import { formPaths, minutesToAnswer, outcomesOf } from './paths'
import { choiceRows, isFormAddress, validateForm } from './validateForm'
import { newQuestion } from './defaults'
import { migrateV1Form } from './migrateV1'
import { parseFormV2, toWireForm } from './formsV2Schema'
import { removeQuestion, renameOptionCode, duplicateQuestion } from './mutations'
import type { ChoiceQuestion, FormV2, Question, Rule } from './formsV2'
import { sampleForm } from '../test/draftHarness'

const choice = (overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion => ({
  id: 'q_reason', type: 'single_select', headline: { en: 'Why?' }, required: true,
  options: [{ code: 'price', label: { en: 'Price' } }, { code: 'bugs', label: { en: 'Bugs' } }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto', ...overrides,
})
const text = (id: string, required = true): Question => ({ id, type: 'open_text', headline: { en: id }, required, long: true, input_type: 'text' })
const formOf = (questions: Question[], endings: FormV2['endings'] = [{ id: 'end_thanks', title: { en: 'Thanks' } }]): FormV2 =>
  sampleForm({ questions, endings })
const codesOf = (form: FormV2) => validateForm(form).map((problem) => problem.code)

describe('codes and ids', () => {
  it('folds Polish and other accents and makes a slug: "Żółć łąka" is zolc_laka', () => {
    expect(slugOf('Żółć łąka')).toBe('zolc_laka')
    expect(foldAccents('Straße é ø')).toBe('Strasse e o')
    expect(slugOf('  --It\'s too   expensive!! ')).toBe('it_s_too_expensive')
  })

  it('gives a clash _2, _3 and never the reserved other / none', () => {
    expect(uniqueSlug('price', new Set(['price', 'price_2']))).toBe('price_3')
    expect(codeFromLabel('Other', new Set())).toBe('other_2')
    expect(isReservedCode('none')).toBe(true)
  })

  it('trims a code to 40 characters and makes ids with their prefixes', () => {
    expect(slugOf('a'.repeat(50))).toHaveLength(40)
    expect(newQuestionId('single_select', new Set(['q_single_select']))).toBe('q_single_select_2')
    expect(duplicateId('q_reason', new Set(['q_reason']))).toBe('q_reason_2')
  })
})

describe('rules', () => {
  it('offers each type its own operators (skipped only when optional)', () => {
    expect(opsFor(choice())).toStrictEqual(['equals', 'not_equals', 'includes_any', 'submitted'])
    expect(opsFor(text('q_a', false))).toStrictEqual(['submitted', 'skipped'])
    expect(opsFor({ ...text('q_s'), type: 'statement' })).toStrictEqual(['submitted'])
    expect(defaultOp({ id: 'q_n', type: 'nps', headline: {}, required: true })).toBe('lte')
  })

  it('stores Otherwise as trailing rules and reads it back (required: submitted; optional: submitted + skipped)', () => {
    const rules: Rule[] = [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'q_price' } }]
    const required = withLogic(choice(), rules, 'q_follow')
    const optional = withLogic(text('q_t', false), [], 'q_follow')
    expect(splitOtherwise(required)).toStrictEqual({ rules, otherwise: 'q_follow' })
    expect(optional.logic?.map((rule) => rule.when.op)).toStrictEqual(['submitted', 'skipped'])
    expect(splitOtherwise(optional).otherwise).toBe('q_follow')
    expect(joinOtherwise(choice(), rules, null)).toStrictEqual(rules)
  })

  it('lists the scale values of NPS, CSAT and a 7-point rating', () => {
    expect(scaleValues({ id: 'q_n', type: 'nps', headline: {}, required: true })).toHaveLength(11)
    expect(scaleValues({ id: 'q_r', type: 'rating', headline: {}, required: true, scale: 'number', range: 7 }).at(-1)).toBe(7)
  })
})

describe('paths', () => {
  const branching = formOf([
    choice({ logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'q_c' } }] }),
    text('q_b'), text('q_c'),
  ])

  it('counts the paths, the shortest and the longest', () => {
    const paths = formPaths(branching)
    expect(paths.total).toBe(2)
    expect([paths.shortest, paths.longest]).toStrictEqual([2, 3])
    expect(minutesToAnswer(branching)).toBe(1)
  })

  it('names where a question sends people: its rules, then the next question', () => {
    expect(outcomesOf(branching, 0)).toStrictEqual([{ target: 'q_c', ruleIndex: 0 }, { target: 'q_b', ruleIndex: null }])
  })

  it('finds a question no path reaches', () => {
    const skipping = formOf([{ ...text('q_a'), logic: [{ when: { op: 'submitted' }, then: { jump_to: 'q_c' } }] }, text('q_b'), text('q_c')])
    expect(formPaths(skipping).questionWays.get('q_b')).toBe(0)
    expect(codesOf(skipping)).toContain('unreachableQuestion')
  })
})

describe('validation (UX §3.6, §5.5)', () => {
  it('refuses an empty headline, a reserved code and a duplicate code', () => {
    const bad = choice({ headline: {}, options: [{ code: 'other', label: { en: 'x' } }, { code: 'a', label: { en: 'A' } }, { code: 'a', label: { en: 'B' } }] })
    expect(codesOf(formOf([bad]))).toStrictEqual(expect.arrayContaining(['headlineEmpty', 'reservedCode', 'duplicateCode']))
  })

  it('reads a form stored with a reserved hidden field id as it is, and refuses the id before it is saved', () => {
    // (the names the widget never fills, 7.58.00; a name that only contains one is any other id)
    const ids = ['__proto__', 'constructor', 'prototype', 'constructor_id']
    const stored = parseFormV2(toWireForm(sampleForm({ hidden_fields: ids.map((id) => ({ id })) })))
    expect(stored?.hidden_fields.map((field) => field.id)).toStrictEqual(ids)
    const problems = validateForm(stored ?? sampleForm()).filter((problem) => problem.at.kind === 'hidden')
    expect(problems.map((problem) => [problem.code, problem.params.id])).toStrictEqual([
      ['reservedHiddenId', '__proto__'], ['reservedHiddenId', 'constructor'], ['reservedHiddenId', 'prototype'],
    ])
  })

  it('refuses min over max, and max over the choices', () => {
    const multi = choice({ type: 'multi_select', min: 3, max: 2 })
    const tooMany = choice({ type: 'multi_select', max: 5 })
    expect(codesOf(formOf([multi]))).toContain('minOverMax')
    expect(codesOf(formOf([tooMany]))).toContain('maxOverChoices')
  })

  it('refuses a rule to a deleted question, a backwards jump, a missing value and a number outside the scale', () => {
    const nps: Question = { id: 'q_n', type: 'nps', headline: { en: 'NPS' }, required: true, logic: [
      { when: { op: 'lte', value: 11 }, then: { jump_to: 'q_gone' } },
      { when: { op: 'gte' }, then: { jump_to: 'q_a' } },
    ] }
    const codes = codesOf(formOf([text('q_a'), nps]))
    expect(codes).toStrictEqual(expect.arrayContaining(['outsideScale', 'targetMissingQuestion', 'noValueNumber', 'targetBackwards']))
  })

  it('warns of a skipped rule on a required question and of a rule that never runs', () => {
    const q = choice({ logic: [
      { when: { op: 'skipped' }, then: { jump_to: 'end_thanks' } },
      { when: { op: 'equals', value: 'price' }, then: { jump_to: 'end_thanks' } },
      { when: { op: 'equals', value: 'price' }, then: { jump_to: 'end_thanks' } },
    ] })
    const problems = validateForm(formOf([q]))
    expect(problems.filter((p) => p.code === 'skippedOnRequired').map((p) => p.severity)).toStrictEqual(['warning'])
    expect(problems.filter((p) => p.code === 'ruleNeverRuns').map((p) => p.at.ruleIndex)).toStrictEqual([2])
  })

  it('takes only https button addresses and wants a contact field shown', () => {
    expect(isFormAddress('https://example.com/help')).toBe(true)
    expect(isFormAddress('http://example.com')).toBe(false)
    const contact = { ...newQuestion('contact_info', 'q_contact'), headline: { en: 'Reach you' }, fields: {
      name: { show: false, required: false }, email: { show: false, required: false }, phone: { show: false, required: false }, company: { show: false, required: false },
    } }
    expect(codesOf(formOf([contact]))).toContain('contactNoField')
  })

  it('counts the Auto rule rows with Other and None: 6 is a list, 7 a dropdown', () => {
    const five = choice({ type: 'multi_select', options: ['a', 'b', 'c', 'd', 'e'].map((code) => ({ code, label: { en: code } })) })
    expect(choiceRows({ ...five, other: { enabled: true } })).toBe(6)
    expect(choiceRows({ ...five, other: { enabled: true }, none: { enabled: true } })).toBe(7)
  })
})

describe('edits', () => {
  it('removing a question removes the rules (and Otherwise) that jumped to it', () => {
    const form = formOf([withLogic(choice(), [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'q_c' } }], 'q_c'), text('q_b'), text('q_c')])
    expect(removeQuestion(form, 'q_c').questions[0]?.logic).toBeUndefined()
  })

  it('renaming a code rewrites the rules that name it, and a duplicate keeps codes and rules', () => {
    const form = formOf([choice({ logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'end_thanks' } }] })])
    const renamed = renameOptionCode(form, 'q_reason', 'price', 'too_expensive')
    expect(renamed.questions[0]?.logic?.[0]?.when.value).toBe('too_expensive')
    expect(duplicateQuestion(form, 'q_reason').form.questions.map((q) => q.id)).toStrictEqual(['q_reason', 'q_reason_2'])
  })
})

describe('the wire and v1 forms', () => {
  it('round-trips a form through the wire, and drops a multi-only field on a single choice', () => {
    const form = formOf([choice({ none: { enabled: true } })])
    const wire = toWireForm(form)
    // (as JSON: the parse spells out the optional fields it did not get as undefined)
    expect(JSON.parse(JSON.stringify(parseFormV2(wire)?.questions[0]))).toStrictEqual({ ...choice(), none: { enabled: false } })
    expect(JSON.stringify(wire)).not.toContain('"none":{')
  })

  it('migrates a v1 form losslessly: the rating, its Question, the text step, the contact fields and the message', () => {
    const { form, languageUnconfirmed } = migrateV1Form({
      name: 'Pilot', title: 'Hi', description: 'D', question: 'Rate us', text_question: '', language: '', rating_enabled: true,
      rating_type: 'numeric', rating_max: 10, placeholder: 'Type', success_message: 'Dzięki', collect_email: true,
    }, 'pl', (key) => (key === 'tellUsMore' ? 'Powiedz nam więcej' : 'Kontakt'))
    expect(languageUnconfirmed).toBe(true)
    expect(form.questions.map((q) => [q.id, q.type, q.headline])).toStrictEqual([
      ['q_rating', 'rating', { pl: 'Rate us' }], ['q_text', 'open_text', { pl: 'Powiedz nam więcej' }], ['q_contact', 'contact_info', { pl: 'Kontakt' }],
    ])
    expect(form.endings).toStrictEqual([{ id: 'end_thanks', title: { pl: 'Dzięki' } }])
  })

  it('titles the text step with v1 Question when the rating is off (a customer pilot)', () => {
    const { form } = migrateV1Form({ question: 'Dlaczego wracasz?', rating_enabled: false, language: 'pl' }, 'en', () => 'x')
    expect(form.questions.map((q) => q.headline)).toStrictEqual([{ pl: 'Dlaczego wracasz?' }])
  })
})
