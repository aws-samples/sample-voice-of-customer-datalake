/**
 * New questions, endings and forms as the builder adds them (UX §3.3, §7), and UX §4.7's type change: only the
 * conversions that keep the content, and what each one loses.
 */
import { describe, expect, it } from 'vitest'
import type { ChoiceQuestion, Question, QuestionType, Rule } from './formsV2'
import { convertQuestion, convertibleTypes, newEnding, unsetFormFields, newQuestion } from './defaults'

const jump = (op: Rule['when']['op'], value?: Rule['when']['value']): Rule => ({ when: { op, value }, then: { jump_to: 'end_thanks' } })

const multi: ChoiceQuestion = {
  id: 'q_why', type: 'multi_select', headline: { en: 'Why?' }, required: true, subheader: { en: 'Pick any' },
  options: [{ code: 'price', label: { en: 'Price' } }, { code: 'bugs', label: { en: 'Bugs' } }],
  other: { enabled: true }, none: { enabled: true }, shuffle: 'all', display: 'list', min: 1, max: 2,
  logic: [jump('includes_all', ['price', 'bugs']), jump('includes_any', ['price'])],
}
const nps: Question = {
  id: 'q_nps', type: 'nps', headline: { en: 'Recommend us?' }, required: true, button_label: { en: 'Next' },
  lower_label: { en: 'Never' }, upper_label: { en: 'Surely' }, logic: [jump('lte', 0), jump('gte', 9), jump('submitted')],
}

describe('new questions, endings and forms', () => {
  it.each<[QuestionType, boolean]>([
    ['single_select', true], ['multi_select', true], ['open_text', false], ['rating', true], ['nps', true],
    ['csat', true], ['ces', true], ['statement', false], ['consent', false], ['contact_info', true],
  ])('starts a %s with an empty headline, required: %s', (type, required) => {
    const question = newQuestion(type, 'q_new')
    expect([question.type, question.headline, question.required]).toStrictEqual([type, {}, required])
  })

  it('gives a choice two empty options and a rating five stars', () => {
    expect(newQuestion('single_select', 'q_a')).toMatchObject({ options: [{ code: 'option', label: {} }, { code: 'option_2', label: {} }], display: 'auto' })
    expect(newQuestion('rating', 'q_b')).toMatchObject({ scale: 'star', range: 5 })
  })

  it('asks a contact question for a name and a required email', () => {
    expect(newQuestion('contact_info', 'q_c')).toMatchObject({ fields: {
      name: { show: true, required: false }, email: { show: true, required: true }, phone: { show: false, required: false },
    } })
  })

  it('starts an ending with its title in the form language, and an untitled one empty', () => {
    expect(newEnding('end_2', 'pl', 'Dziękujemy')).toStrictEqual({ id: 'end_2', title: { pl: 'Dziękujemy' } })
    expect(newEnding('end_3', 'en', '')).toStrictEqual({ id: 'end_3', title: {} })
  })

  it('starts a form with its test link off, test responses kept, and nothing routed', () => {
    const settings = unsetFormFields()
    expect(settings.settings).toStrictEqual({ test: { link_enabled: false, record: 'tag' } })
    expect([settings.category, settings.tags, settings.custom_fields]).toStrictEqual(['', [], []])
  })
})

describe('convertibleTypes', () => {
  it('swaps single and multiple choice, and a scale for the other scales', () => {
    expect(convertibleTypes(multi)).toStrictEqual(['single_select'])
    expect(convertibleTypes({ ...multi, type: 'single_select' })).toStrictEqual(['multi_select'])
    expect(convertibleTypes(nps)).toStrictEqual(['rating', 'csat', 'ces'])
  })

  it('offers nothing to a question whose content no other type keeps', () => {
    expect(convertibleTypes(newQuestion('open_text', 'q_t'))).toStrictEqual([])
    expect(convertQuestion(newQuestion('open_text', 'q_t'), 'nps')).toBeNull()
    expect(convertQuestion(multi, 'rating')).toBeNull()
  })
})

describe('convertQuestion', () => {
  it('makes a multiple choice single, losing None, its min / max and its "includes all" rules', () => {
    const converted = convertQuestion(multi, 'single_select')
    expect(converted?.lost).toStrictEqual(['none', 'minMax', 'includesAll'])
    expect(converted?.question).toMatchObject({ type: 'single_select', none: { enabled: false }, min: undefined, max: undefined })
    expect(converted?.question.logic).toStrictEqual([jump('includes_any', ['price'])])
  })

  it('loses nothing making a plain multiple choice single', () => {
    const plain: ChoiceQuestion = { ...multi, none: { enabled: false }, min: undefined, max: undefined, logic: undefined }
    const converted = convertQuestion(plain, 'single_select')
    expect(converted?.lost).toStrictEqual([])
    expect(converted?.question.logic).toBeUndefined()
  })

  it('makes a single choice multiple: "is" becomes "includes any of", "is not" goes', () => {
    const single: ChoiceQuestion = { ...multi, type: 'single_select', logic: [jump('equals', 'price'), jump('not_equals', 'bugs'), jump('submitted')] }
    const converted = convertQuestion(single, 'multi_select')
    expect(converted?.lost).toStrictEqual([])
    expect(converted?.question.logic).toStrictEqual([jump('includes_any', ['price']), jump('submitted')])
  })

  it('makes an NPS a 10-point number rating, keeping its texts and the rules inside 1–10', () => {
    const converted = convertQuestion(nps, 'rating')
    expect(converted?.question).toMatchObject({ type: 'rating', scale: 'number', range: 10, lower_label: { en: 'Never' }, button_label: { en: 'Next' } })
    expect(converted?.question.logic).toStrictEqual([jump('gte', 9), jump('submitted')])
    expect(converted?.lost).toStrictEqual(['rulesOutsideScale'])
  })

  it('makes an NPS a CSAT, dropping every number rule outside 1–5', () => {
    const converted = convertQuestion({ ...nps, logic: [jump('gte', 9)] }, 'csat')
    expect(converted?.question).toMatchObject({ id: 'q_nps', type: 'csat', headline: { en: 'Recommend us?' }, logic: undefined })
    expect(converted?.lost).toStrictEqual(['rulesOutsideScale'])
  })
})
