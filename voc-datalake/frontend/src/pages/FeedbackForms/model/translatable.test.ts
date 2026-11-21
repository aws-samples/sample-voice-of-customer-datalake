/**
 * Every text of a form a translator writes (UX §8): one entry per field in form order, each writing its own field, and
 * what is missing in a language (the primary has it, the translation does not).
 */
import { describe, expect, it } from 'vitest'
import type { ChoiceQuestion, FormV2 } from './formsV2'
import { newQuestion } from './defaults'
import { sampleForm } from '../test/draftHarness'
import { missingLanguagesOf, missingTexts, textsToTranslate, translatableTexts } from './translatable'

const en = (text: string) => ({ en: text })

/** A new single choice (two empty options), as the builder adds it. */
const ONE: ChoiceQuestion = {
  id: 'q_one', type: 'single_select', required: true, headline: {},
  options: [{ code: 'option', label: {} }, { code: 'option_2', label: {} }], other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
}

const FORM: FormV2 = sampleForm({
  languages: ['en', 'pl', 'de'],
  questions: [
    {
      id: 'q_pick', type: 'multi_select', required: true, headline: { en: 'Pick', pl: 'Wybierz' }, subheader: en('Any'), button_label: en('Next'),
      options: [{ code: 'fast', label: { en: 'Fast', pl: 'Szybko' } }], shuffle: 'all', display: 'chips',
      other: { enabled: true, label: en('Else'), placeholder: en('Say') }, none: { enabled: true, label: en('None') },
    },
    { id: 'q_text', type: 'open_text', required: false, long: false, input_type: 'email', headline: en('Tell us'), placeholder: en('Type') },
    { id: 'q_nps', type: 'nps', headline: en('Recommend?'), required: true, lower_label: en('No'), upper_label: en('Yes') },
    { id: 'q_ok', type: 'consent', required: false, headline: en('Contact?'), label: en('I agree') },
    { id: 'q_note', type: 'statement', required: false, headline: en('Note'), cta: { label: en('Read'), url: 'https://example.com' } },
    { ...newQuestion('statement', 'q_bare'), headline: en('Plain') },
    { ...newQuestion('contact_info', 'q_contact'), headline: en('Reach you') },
  ],
  welcome: { enabled: true, title: en('Hi'), description: en('Two minutes'), button_label: en('Start') },
  endings: [{ id: 'end_thanks', title: en('Thanks'), description: en('Bye'), button: { label: en('Home'), url: 'https://example.com' } }],
})

describe('translatableTexts', () => {
  it('lists every text in form order: the questions, then the welcome card, then the endings', () => {
    expect(translatableTexts(FORM).map((entry) => entry.key)).toStrictEqual([
      'q_pick.headline', 'q_pick.subheader', 'q_pick.option.1', 'q_pick.otherLabel', 'q_pick.otherPlaceholder', 'q_pick.noneLabel', 'q_pick.buttonLabel',
      'q_text.headline', 'q_text.subheader', 'q_text.placeholder', 'q_text.buttonLabel',
      'q_nps.headline', 'q_nps.subheader', 'q_nps.lowerLabel', 'q_nps.upperLabel', 'q_nps.buttonLabel',
      'q_ok.headline', 'q_ok.subheader', 'q_ok.consentLabel', 'q_ok.buttonLabel',
      'q_note.headline', 'q_note.subheader', 'q_note.ctaLabel', 'q_note.buttonLabel',
      'q_bare.headline', 'q_bare.subheader', 'q_bare.buttonLabel',
      'q_contact.headline', 'q_contact.subheader', 'q_contact.buttonLabel',
      'welcome.welcomeTitle', 'welcome.welcomeDescription', 'welcome.welcomeButton',
      'end_thanks.endingTitle', 'end_thanks.endingDescription', 'end_thanks.endingButton',
    ])
  })

  it('writes each text in its own field', () => {
    const entries = textsToTranslate(FORM)
    const written = entries.reduce((form, entry) => entry.write(form, 'de', `de ${entry.key}`), FORM)
    expect(textsToTranslate(written).map((entry) => entry.text?.de)).toStrictEqual(entries.map((entry) => `de ${entry.key}`))
    expect(missingTexts(written, 'de')).toStrictEqual([])
  })

  it('says whose text an entry is, and which texts are required', () => {
    const required = translatableTexts(FORM).filter((entry) => entry.required).map((entry) => entry.key)
    expect(required).toStrictEqual(['q_pick.headline', 'q_pick.option.1', 'q_text.headline', 'q_nps.headline', 'q_ok.headline', 'q_ok.consentLabel',
      'q_note.headline', 'q_bare.headline', 'q_contact.headline', 'welcome.welcomeTitle', 'end_thanks.endingTitle'])
    expect(translatableTexts(FORM).at(-1)?.owner).toStrictEqual({ kind: 'ending', id: 'end_thanks' })
  })

  it('leaves out a welcome card that is off, an Other that is off and a single choice\'s None', () => {
    const plain = sampleForm({ welcome: { enabled: false, title: en('Hi') }, questions: [{ ...ONE, none: { enabled: true } }] })
    expect(translatableTexts(plain).map((entry) => entry.key)).toStrictEqual([
      'q_one.headline', 'q_one.subheader', 'q_one.option.1', 'q_one.option.2', 'q_one.buttonLabel', 'end_thanks.endingTitle', 'end_thanks.endingDescription',
    ])
  })
})

describe('what a translation misses', () => {
  it('lists the texts the primary has and the translation does not', () => {
    const missing = missingTexts(FORM, 'pl').map((entry) => entry.key)
    expect(missing).toHaveLength(textsToTranslate(FORM).length - 2)
    expect(missing).not.toContain('q_pick.headline')
    expect(missingTexts(FORM, 'en')).toStrictEqual([])
  })

  it('badges a card with the languages missing one of its required texts only', () => {
    expect(missingLanguagesOf(FORM, 'q_pick')).toStrictEqual(['de'])
    expect(missingLanguagesOf(FORM, 'q_text')).toStrictEqual(['pl', 'de'])
    expect(missingLanguagesOf(FORM, 'welcome')).toStrictEqual(['pl', 'de'])
  })
})
