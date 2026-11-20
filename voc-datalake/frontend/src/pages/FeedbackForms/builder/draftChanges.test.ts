/**
 * A draft's changes in words (UX §3.6, D7): what an update of a live form removes that respondents answered (its
 * questions, the options of a choice it keeps, its endings), and what saving mine would change in theirs after a stale
 * save (added, changed and removed questions, endings, hidden fields, languages and the welcome card).
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import type { ChoiceQuestion, FormV2, Question } from '../model/formsV2'
import { sampleForm } from '../test/draftHarness'
import { defined } from '../../../test/defined'
import { conflictDifferences, removedParts } from './draftChanges'
import type { ConflictDifference } from './draftChanges'

const t = i18n.getFixedT('en', 'feedbackForms')

const reason: ChoiceQuestion = {
  id: 'q_reason', type: 'single_select', headline: { en: 'Why are you leaving?' }, required: true,
  options: [{ code: 'price', label: { en: 'Price' } }, { code: 'bugs', label: { en: 'Bugs' } }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
}
const note: Question = { id: 'q_note', type: 'statement', headline: { en: 'Thanks for that' }, required: false }
const feedback = defined(sampleForm().questions[0], 'q_feedback')

/** The live form: the sample question, a choice and a statement, and two endings. */
const LIVE: FormV2 = sampleForm({
  questions: [feedback, reason, note],
  endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }, { id: 'end_bye', title: { en: 'Bye' } }],
})

describe('removedParts', () => {
  it('is nothing when the draft keeps every question, option and ending', () => {
    expect(removedParts(t, LIVE, { ...LIVE, name: 'Renamed' })).toStrictEqual([])
  })

  it('names the removed questions, then the options of a kept choice, then the endings', () => {
    const draft: FormV2 = {
      ...LIVE,
      questions: [{ ...reason, options: [{ code: 'bugs', label: { en: 'Bugs' } }] }],
      endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }],
    }
    expect(removedParts(t, LIVE, draft)).toStrictEqual([
      'question “What would you like to tell us?”', 'question “Thanks for that”', 'option “Price”', 'ending “Bye”',
    ])
  })

  it('names no options of a choice that is no longer a choice', () => {
    const asText: Question = { id: 'q_reason', type: 'open_text', headline: { en: 'Why are you leaving?' }, required: true, long: true, input_type: 'text' }
    expect(removedParts(t, LIVE, { ...LIVE, questions: [feedback, asText, note] })).toStrictEqual([])
  })

  it('names the parts in the live form\'s language', () => {
    const polish: FormV2 = { ...LIVE, language: 'pl', languages: ['pl', 'en'], endings: [{ id: 'end_thanks', title: { en: 'Thank you!', pl: 'Dziękujemy!' } }] }
    expect(removedParts(t, polish, { ...polish, endings: [] })).toStrictEqual(['ending “Dziękujemy!”'])
  })
})

describe('conflictDifferences', () => {
  const differences = (mine: FormV2): ConflictDifference[] => conflictDifferences(t, LIVE, mine)

  it('is nothing when mine matches theirs', () => {
    expect(differences({ ...LIVE })).toStrictEqual([])
  })

  it('names an added, a changed and a removed question by their number and headline in mine', () => {
    const added: Question = { id: 'q_more', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: false, input_type: 'text' }
    const mine: FormV2 = { ...LIVE, questions: [{ ...reason, required: false }, note, added] }
    expect(differences(mine)).toStrictEqual([
      { kind: 'changed', label: '1 · Why are you leaving?' },
      { kind: 'added', label: '3 · Anything else?' },
      { kind: 'removed', label: '1 · What would you like to tell us?' },
    ])
  })

  it('names endings, hidden fields, languages and the welcome card by what they are', () => {
    const mine: FormV2 = {
      ...LIVE,
      languages: ['en', 'pl'],
      hidden_fields: [{ id: 'plan' }],
      welcome: { enabled: true, title: { en: 'Hello' } },
      endings: [{ id: 'end_thanks', title: { en: 'Thanks a lot' } }],
    }
    expect(differences(mine)).toStrictEqual([
      { kind: 'changed', label: 'Ending: Thanks a lot' },
      { kind: 'added', label: 'Hidden field plan' },
      { kind: 'added', label: 'Polski' },
      { kind: 'changed', label: 'Welcome card' },
      { kind: 'removed', label: 'Ending: Bye' },
    ])
  })
})
