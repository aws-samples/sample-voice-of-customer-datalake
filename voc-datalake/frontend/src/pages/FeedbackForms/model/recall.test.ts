import { describe, expect, it } from 'vitest'
import recallCases from '../../../../../schemas/form-recall-cases.json'
import type { FormV2, Question } from './formsV2'
import { blankForm } from '../test/blankForm'
import {
  otherTexts, placeholders, recallChoices, recallProblem, recallTexts, recalledHiddenIds, renderRecall, shownAsIds,
  unresolvedPlaceholders,
} from './recall'

const en = (text: string) => ({ en: text })
const nps: Question = { id: 'q_nps', type: 'nps', headline: en('How likely?'), required: true }
const pick: Question = {
  id: 'q_pick', type: 'single_select', headline: en('Pick'), required: false, options: [{ code: 'a', label: en('A {{x}}') }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
}
const text: Question = { id: 'q_text', type: 'open_text', headline: en('Why {{q_nps}}?'), required: false, long: true, input_type: 'text' }

function formWith(questions: readonly Question[], extra: Partial<FormV2> = {}): FormV2 {
  return { ...blankForm('en'), questions, hidden_fields: [{ id: 'event' }, { id: 'unused' }], ...extra }
}

describe('recall (schemas/form-recall-cases.json: one grammar with the server and the widget)', () => {
  it.each(recallCases.parse)('finds the placeholders of "$text"', ({ text: written, placeholders: expected }) => {
    expect(placeholders(written)).toStrictEqual(expected)
  })

  it('fills the builder\'s preview by plain substitution: a value, else the fallback, else nothing (the widget tidies)', () => {
    expect(renderRecall('How was {{ event }}?', { event: '‹Event›' })).toBe('How was ‹Event›?')
    expect(renderRecall('How was {{event|the event}}?', {})).toBe('How was the event?')
    // (never tidied here: the widget's preview shows how respondents read a text without the value)
    expect(renderRecall('Thanks {{name}}, {{company}}!', {})).toBe('Thanks , !')
    expect(renderRecall('No placeholder, two  spaces', {})).toBe('No placeholder, two  spaces')
  })

  it('shows a text to a reader of results with each placeholder as its id', () => {
    expect(shownAsIds('How was {{ event | the event }} after {{q_nps}}?')).toBe('How was [event] after [q_nps]?')
  })

  it('never reads a value off an object\'s own machinery', () => {
    expect(renderRecall('A {{constructor}} B {{toString|x}}', {})).toBe('A  B x')
  })
})

describe('recallProblem', () => {
  const form = formWith([nps, pick, text])

  it('takes a hidden field anywhere, and an earlier score or single choice', () => {
    expect([recallProblem(form, 0, 'event'), recallProblem(form, 2, 'q_nps'), recallProblem(form, 2, 'q_pick')])
      .toStrictEqual([null, null, null])
  })

  it('refuses an id that names nothing, a question at or after the text, and an answer never recalled', () => {
    expect([recallProblem(form, 3, 'nobody'), recallProblem(form, 0, 'q_nps'), recallProblem(form, 1, 'q_pick'),
      recallProblem(form, 3, 'q_text')]).toStrictEqual(['recall_unknown', 'recall_not_before', 'recall_not_before', 'recall_type'])
  })
})

describe('unresolvedPlaceholders', () => {
  it('lists a recall text that cannot be filled and any placeholder where recall never works, with its language', () => {
    const form = formWith([nps, pick, { ...text, headline: en('Why {{q_nps}} and {{q_text}}?') }])
    expect(unresolvedPlaceholders(form)).toStrictEqual([
      { at: { kind: 'question', id: 'q_text', field: 'headline' }, language: 'en', placeholder: '{{q_text}}', code: 'recall_not_before' },
      { at: { kind: 'question', id: 'q_pick', field: 'option', optionIndex: 0 }, language: 'en', placeholder: '{{x}}', code: 'recall_not_here' },
    ])
  })

  it('checks the welcome, the endings and their buttons too', () => {
    const form = formWith([nps], {
      welcome: { enabled: true, title: en('Hi {{q_nps}}'), button_label: en('Go {{event}}') },
      endings: [{ id: 'end_a', title: en('Bye {{q_nps}}'), button: { label: en('More'), url: 'https://x.example/{{event}}' } }],
    })
    expect(unresolvedPlaceholders(form).map((found) => [found.at.kind, found.at.field, found.code])).toStrictEqual([
      ['welcome', 'title', 'recall_not_before'], ['welcome', 'button_label', 'recall_not_here'], ['ending', 'button_url', 'recall_not_here'],
    ])
  })
})

describe('what a text may recall', () => {
  const form = formWith([nps, pick, text, { ...text, id: 'q_end', headline: en('Ok {{event}} {{ q_nps | x }}') }])

  it('offers every hidden field and the earlier recallable questions', () => {
    const choices = recallChoices(form, 3)
    expect(choices.hidden.map((field) => field.id)).toStrictEqual(['event', 'unused'])
    expect(choices.questions.map((q) => q.id)).toStrictEqual(['q_nps', 'q_pick'])
    expect(recallChoices(form, 0).questions).toStrictEqual([])
  })

  it('names the hidden fields the recall texts use, in the form\'s order', () => {
    expect(recalledHiddenIds(form)).toStrictEqual(['event'])
  })

  it('places each recall text after the questions before it, and lists the other texts apart', () => {
    expect(recallTexts(form).filter((entry) => entry.at.field === 'headline').map((entry) => entry.before)).toStrictEqual([0, 1, 2, 3])
    expect(otherTexts(form).some((entry) => entry.at.field === 'option')).toBe(true)
  })
})
