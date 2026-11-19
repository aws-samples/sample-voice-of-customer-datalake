/**
 * The builder's edits as pure functions (UX §3.3, §7, §8): removing a question or an ending removes the rules that
 * jumped to it, renaming an id or a code rewrites the rules that name it, and removing a language removes its texts.
 */
import { describe, expect, it } from 'vitest'
import type { FormV2, Question, Rule } from './formsV2'
import { newQuestion } from './defaults'
import { withLogic } from './rules'
import { sampleForm } from '../test/draftHarness'
import {
  addLanguage, insertEnding, moveEnding, moveQuestion, moved, removeEnding, removeLanguage, renameEndingId, renameOptionCode,
  renameQuestionId, rulesTargeting, setPrimaryLanguage, updateChoice, updateEnding,
} from './mutations'

const to = (target: string, op: Rule['when']['op'] = 'submitted', value?: Rule['when']['value']): Rule => ({ when: { op, value }, then: { jump_to: target } })
const both = { en: 'Hello', pl: 'Cześć' }

/** q_pick jumps to q_end or to the ending end_sorry; its Otherwise goes to end_sorry. */
const pick: Question = withLogic({
  ...newQuestion('multi_select', 'q_pick'), headline: { en: 'Pick' },
  options: [{ code: 'fast', label: { en: 'Fast' } }, { code: 'cheap', label: { en: 'Cheap' } }],
}, [to('q_end', 'includes_any', ['fast', 'cheap']), to('end_sorry', 'includes_all', ['cheap'])], 'end_sorry')

const FORM: FormV2 = sampleForm({
  languages: ['en', 'pl'],
  questions: [pick, { ...newQuestion('statement', 'q_end'), headline: { en: 'Thanks for that' } }],
  endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }, { id: 'end_sorry', title: { en: 'Sorry' } }],
})

describe('moved', () => {
  it('moves an item, clamped to the list, and leaves a list alone for an index it does not have', () => {
    expect(moved(['a', 'b', 'c'], 0, 9)).toStrictEqual(['b', 'c', 'a'])
    expect(moved(['a', 'b', 'c'], 2, -1)).toStrictEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b'], 5, 0)).toStrictEqual(['a', 'b'])
  })

  it('moves a question by its id', () => {
    expect(moveQuestion(FORM, 'q_end', 0).questions.map((question) => question.id)).toStrictEqual(['q_end', 'q_pick'])
  })
})

describe('endings', () => {
  it('adds an ending last and moves it', () => {
    const added = insertEnding(FORM, { id: 'end_new', title: {} })
    expect(added.endings.map((ending) => ending.id)).toStrictEqual(['end_thanks', 'end_sorry', 'end_new'])
    expect(moveEnding(added, 'end_new', 0).endings.map((ending) => ending.id)).toStrictEqual(['end_new', 'end_thanks', 'end_sorry'])
  })

  it('edits only the ending it names', () => {
    const edited = updateEnding(FORM, 'end_sorry', (ending) => ({ ...ending, title: { en: 'So sorry' } }))
    expect(edited.endings.map((ending) => ending.title)).toStrictEqual([{ en: 'Thank you!' }, { en: 'So sorry' }])
  })

  it('removes an ending with the rules and the Otherwise that ended there', () => {
    expect(rulesTargeting(FORM, 'end_sorry')).toBe(2)
    const removed = removeEnding(FORM, 'end_sorry')
    expect(removed.endings.map((ending) => ending.id)).toStrictEqual(['end_thanks'])
    expect(removed.questions[0]?.logic).toStrictEqual([to('q_end', 'includes_any', ['fast', 'cheap'])])
  })

  it('renames an ending and every jump to it, its Otherwise too', () => {
    const renamed = renameEndingId(FORM, 'end_sorry', 'end_oops')
    expect(renamed.endings.map((ending) => ending.id)).toStrictEqual(['end_thanks', 'end_oops'])
    expect(rulesTargeting(renamed, 'end_oops')).toBe(2)
    expect(rulesTargeting(renamed, 'end_sorry')).toBe(0)
  })
})

describe('renaming', () => {
  it('renames a question and the rules that jump to it', () => {
    const renamed = renameQuestionId(FORM, 'q_end', 'q_closing')
    expect(renamed.questions.map((question) => question.id)).toStrictEqual(['q_pick', 'q_closing'])
    expect(renamed.questions[0]?.logic?.[0]?.then).toStrictEqual({ jump_to: 'q_closing' })
  })

  it('renames an option code inside the code lists of the question\'s rules, and its option', () => {
    const renamed = renameOptionCode(FORM, 'q_pick', 'cheap', 'low_price')
    expect(renamed.questions[0]?.logic?.map((rule) => rule.when.value)).toStrictEqual([['fast', 'low_price'], ['low_price'], undefined])
    expect(renamed.questions[0]).toMatchObject({ options: [{ code: 'fast' }, { code: 'low_price' }] })
  })

  it('leaves a question without options as it is', () => {
    expect(renameOptionCode(FORM, 'q_end', 'cheap', 'x')).toStrictEqual(FORM)
    expect(updateChoice(FORM, 'q_end', (q) => ({ ...q, headline: { en: 'Changed' } })).questions[1]?.headline).toStrictEqual({ en: 'Thanks for that' })
  })
})

describe('languages', () => {
  const texts: FormV2 = sampleForm({
    languages: ['en', 'pl'],
    questions: [
      { id: 'q_score', type: 'rating', headline: both, required: true, scale: 'number', range: 5, lower_label: both, upper_label: both },
      { id: 'q_ok', type: 'consent', headline: both, required: false, label: both },
      { id: 'q_note', type: 'statement', headline: both, required: false, cta: { label: both, url: 'https://example.com' } },
      { id: 'q_bare', type: 'statement', headline: both, required: false },
      { ...newQuestion('contact_info', 'q_contact'), headline: both },
    ],
    welcome: { enabled: true, title: both, button_label: both },
    endings: [{ id: 'end_thanks', title: both, button: { label: both, url: 'https://example.com' } }],
  })

  it('adds a language once', () => {
    expect(addLanguage(texts, 'de').languages).toStrictEqual(['en', 'pl', 'de'])
    expect(addLanguage(texts, 'pl')).toBe(texts)
  })

  it('removes a translation with its texts, on every kind of question, the welcome card and the endings', () => {
    const removed = removeLanguage(texts, 'pl')
    expect(removed.languages).toStrictEqual(['en'])
    expect(removed.questions.slice(0, 3)).toMatchObject([
      { lower_label: { en: 'Hello' }, upper_label: { en: 'Hello' } }, { label: { en: 'Hello' } }, { cta: { label: { en: 'Hello' } } },
    ])
    expect(removed.questions.map((question) => question.headline)).toStrictEqual(Array.from({ length: 5 }, () => ({ en: 'Hello' })))
    expect([removed.welcome.title, removed.endings[0]?.button?.label]).toStrictEqual([{ en: 'Hello' }, { en: 'Hello' }])
  })

  it('never removes the primary language', () => {
    expect(removeLanguage(texts, 'en')).toBe(texts)
  })

  it('makes a translation the primary, the old primary becoming a translation', () => {
    const swapped = setPrimaryLanguage(texts, 'pl')
    expect([swapped.language, swapped.languages]).toStrictEqual(['pl', ['pl', 'en']])
  })
})
