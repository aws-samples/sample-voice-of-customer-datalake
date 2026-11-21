import { describe, expect, it } from 'vitest'
import type { FormV2, Question } from './formsV2'
import { blankForm } from '../test/blankForm'
import { blockingProblems, publishBlockingProblems, validateForm } from './validateForm'
import { recallProblems } from './recallProblems'

const en = (text: string) => ({ en: text })
const nps: Question = { id: 'q_nps', type: 'nps', headline: en('How likely are you to recommend {{event}}?'), required: true }
const pick: Question = {
  id: 'q_pick', type: 'single_select', headline: en('Why {{q_nps}}?'), required: true, options: [{ code: 'a', label: en('A') }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
}
const form = (questions: readonly Question[], extra: Partial<FormV2> = {}): FormV2 => ({
  ...blankForm('en'), category: 'other', questions, hidden_fields: [{ id: 'event' }], endings: [{ id: 'end_thanks', title: en('Thanks') }], ...extra,
})
const recallCodes = (draft: FormV2) => validateForm(draft).filter((p) => p.code.startsWith('recall')).map((p) => p.code)

describe('recall in the form\'s problems', () => {
  it('finds nothing wrong with a hidden field and an earlier score recalled', () => {
    expect(recallCodes(form([nps, pick]))).toStrictEqual([])
  })

  it('blocks only Publish for a recall text that names nothing, a later question or an answer never shown (7.63.00)', () => {
    const text: Question = { id: 'q_text', type: 'open_text', headline: en('Tell us'), required: false, long: true, input_type: 'text' }
    const draft = form([{ ...nps, headline: en('{{nobody}} and {{q_pick}}') }, pick, text], {
      endings: [{ id: 'end_thanks', title: en('Thanks for {{q_text}}') }],
    })
    expect(recallCodes(draft)).toStrictEqual(['recallUnknown', 'recallNotBefore', 'recallType'])
    // (a draft saves with them, as the server keeps it: its 409 when the form would go live is the one rule)
    const found = validateForm(draft).filter((p) => p.code.startsWith('recall'))
    expect([blockingProblems(found).length, publishBlockingProblems(found).length]).toStrictEqual([0, 3])
  })

  it('blocks only Publish for a placeholder where recall never works, at that option', () => {
    const draft = form([nps, { ...pick, options: [{ code: 'a', label: en('Yes {{event}}') }] }])
    const found = validateForm(draft).filter((p) => p.code === 'recallNotHere')
    expect(found.map((p) => [p.blocks, p.at])).toStrictEqual([['publish', { kind: 'question', id: 'q_pick', field: 'option', optionIndex: 0 }]])
    expect([blockingProblems(found).length, publishBlockingProblems(found).length]).toStrictEqual([0, 1])
  })

  it('names the placeholder and the language of the text it is in (the primary for an address)', () => {
    const draft = form([nps], { languages: ['en', 'pl'], endings: [{ id: 'end_thanks', title: { en: 'Thanks', pl: 'Dzięki {{kto}}' },
      button: { label: en('More'), url: 'https://example.com/{{event}}' } }] })
    expect(recallProblems(draft).map((p) => p.params)).toStrictEqual([
      { placeholder: '{{kto}}', language: 'pl' }, { placeholder: '{{event}}', language: 'en' },
    ])
  })
})
