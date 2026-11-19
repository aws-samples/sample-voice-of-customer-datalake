import { describe, expect, it } from 'vitest'
import type { FormV2, Question } from './formsV2'
import { blankForm } from '../test/blankForm'
import { effectiveChanges, formDiff } from './formDiff'
import { applyChanges, rulesTo } from './formDiffApply'

const reason: Question = {
  id: 'q_reason', type: 'single_select', headline: { pl: 'Jaki jest główny powód rezygnacji?' }, required: true,
  options: [{ code: 'too_expensive', label: { pl: 'Jest dla mnie za drogo' } }, { code: 'other_tool', label: { pl: 'Inne narzędzie' } }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
}
const feature: Question = { id: 'q_feature', type: 'open_text', headline: { pl: 'Której funkcji Ci brakowało?' }, required: false, long: false, input_type: 'text' }
const comment: Question = { id: 'q_comment', type: 'open_text', headline: { pl: 'Komentarz' }, required: false, long: true, input_type: 'text' }

function base(): FormV2 {
  return {
    ...blankForm('pl'), name: 'Rezygnacja', questions: [reason, feature, comment],
    endings: [{ id: 'end_thanks', title: { pl: 'Dziękujemy' } }],
  }
}

/** The AI's proposal: a price follow-up routed from "too expensive", q_comment removed, English, an ending button. */
function proposal(): FormV2 {
  const price: Question = { id: 'q_price', type: 'open_text', headline: { pl: 'Jaka cena byłaby uczciwa?', en: 'What price would be fair?' }, required: false, long: false, input_type: 'text' }
  return {
    ...base(),
    name: 'Renamed by the AI',
    theme: { ...base().theme, primary_color: '#000000' },
    languages: ['pl', 'en'],
    questions: [
      { ...reason, headline: { pl: 'Jaki jest główny powód rezygnacji?', en: 'Why are you cancelling?' }, logic: [{ when: { op: 'equals', value: 'too_expensive' }, then: { jump_to: 'q_price' } }] },
      price,
      { ...feature, headline: { pl: 'Jakiej funkcji Ci brakowało?', en: 'Which feature were you missing?' } },
    ],
    endings: [{ id: 'end_thanks', title: { pl: 'Dziękujemy', en: 'Thank you' }, button: { label: { pl: 'Pomoc' }, url: 'https://example.com/pomoc' } }],
  }
}

const keys = (form: FormV2) => form.questions.map((q) => q.id)

describe('formDiff', () => {
  it('keys each change by id, and counts a new language as its own change, not an edit of every question', () => {
    const diff = formDiff(base(), proposal())
    expect(diff.changes.map((change) => `${change.kind} ${change.key}`)).toStrictEqual([
      'changed question:q_reason', 'added question:q_price', 'changed question:q_feature', 'removed question:q_comment',
      'changed ending:end_thanks', 'added language:en',
    ])
    expect(diff.changes[0]?.fields.map((field) => field.field)).toStrictEqual(['logic'])
  })

  it('lists what it may not change as ignored', () => {
    expect(formDiff(base(), proposal()).ignored).toStrictEqual(['name', 'theme'])
  })

  it('holds a change that brings in an address until the address is checked', () => {
    const diff = formDiff(base(), proposal())
    const all = new Set(diff.changes.map((change) => change.key))
    expect(diff.changes[4]?.addresses.map((address) => address.url)).toStrictEqual(['https://example.com/pomoc'])
    expect(effectiveChanges(diff, all, new Set()).has('ending:end_thanks')).toBe(false)
    expect(effectiveChanges(diff, all, new Set(['https://example.com/pomoc'])).has('ending:end_thanks')).toBe(true)
  })
})

describe('applyChanges', () => {
  it('applies every accepted change, and never the ignored areas', () => {
    const before = base()
    const diff = formDiff(before, proposal())
    const applied = applyChanges(before, proposal(), diff, new Set(diff.changes.map((change) => change.key)))
    expect(keys(applied)).toStrictEqual(['q_reason', 'q_price', 'q_feature'])
    expect(applied.languages).toStrictEqual(['pl', 'en'])
    expect([applied.name, applied.theme.primary_color]).toStrictEqual(['Rezygnacja', before.theme.primary_color])
  })

  it('drops the rule that goes to a rejected added question, and says which question had it', () => {
    const before = base()
    const diff = formDiff(before, proposal())
    const applied = applyChanges(before, proposal(), diff, new Set(['question:q_reason', 'question:q_feature', 'question:q_comment']))
    expect(keys(applied)).toStrictEqual(['q_reason', 'q_feature'])
    expect(applied.questions[0]?.logic).toBeUndefined()
    expect(rulesTo(proposal(), 'q_price')).toStrictEqual([1])
  })

  it('keeps a question whose removal was rejected in its place, with the rules that went to it', () => {
    const before: FormV2 = { ...base(), questions: [{ ...reason, logic: [{ when: { op: 'equals', value: 'other_tool' }, then: { jump_to: 'q_comment' } }] }, feature, comment] }
    const after = proposal()
    const diff = formDiff(before, after)
    const applied = applyChanges(before, after, diff, new Set(['question:q_reason', 'question:q_price']))
    expect(keys(applied)).toStrictEqual(['q_reason', 'q_price', 'q_feature', 'q_comment'])
    expect(applied.questions[0]?.logic?.map((rule) => rule.then.jump_to)).toStrictEqual(['q_price', 'q_comment'])
  })

  it('leaves out a rejected language and its texts, and a rejected change as it was', () => {
    const before = base()
    const diff = formDiff(before, proposal())
    const applied = applyChanges(before, proposal(), diff, new Set(['question:q_price']))
    expect(applied.languages).toStrictEqual(['pl'])
    expect(applied.questions.map((q) => q.headline)).toStrictEqual([
      { pl: 'Jaki jest główny powód rezygnacji?' }, { pl: 'Jaka cena byłaby uczciwa?' }, { pl: 'Której funkcji Ci brakowało?' }, { pl: 'Komentarz' },
    ])
  })
})
