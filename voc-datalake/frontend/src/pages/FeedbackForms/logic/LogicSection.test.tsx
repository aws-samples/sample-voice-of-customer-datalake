import { describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LogicSection from './LogicSection'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { ChoiceQuestion, FormV2, Question, Rule } from '../model/formsV2'

const reason = (logic?: readonly Rule[], required = true): ChoiceQuestion => ({
  id: 'q_reason', type: 'single_select', headline: { en: 'Why are you leaving?' }, required, logic,
  options: [{ code: 'price', label: { en: 'Too expensive' } }, { code: 'missing', label: { en: 'Missing features' } }],
  other: { enabled: true }, none: { enabled: false }, shuffle: 'none', display: 'auto',
})
const followUp: Question = { id: 'q_price', type: 'open_text', headline: { en: 'What price is fair?' }, required: false, long: true, input_type: 'text' }
const last: Question = { id: 'q_last', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: true, input_type: 'text' }

function formOf(questions: readonly Question[]): FormV2 {
  return sampleForm({ questions, endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }, { id: 'end_bye', title: { en: 'Goodbye' } }] })
}

const rule = (op: Rule['when']['op'], value: Rule['when']['value'], to: string): Rule =>
  (value === undefined ? { when: { op }, then: { jump_to: to } } : { when: { op, value }, then: { jump_to: to } })

const logicOf = (form: FormV2 | undefined, id: string) => form?.questions.find((q) => q.id === id)?.logic

describe('LogicSection: the rules of a question as sentences of controls', () => {
  it('says a rule goes to a question that was deleted', () => {
    renderWithDraft(<LogicSection questionId="q_reason" />, formOf([reason([rule('equals', 'price', 'q_gone')]), followUp]))
    expect(screen.getByText('This rule goes to a question that was deleted. Choose where it should go.')).toBeInTheDocument()
  })

  it('says a jump that became backwards only goes forward', () => {
    renderWithDraft(<LogicSection questionId="q_reason" />, formOf([followUp, reason([rule('equals', 'price', 'q_price')])]))
    expect(screen.getByText(/Jumps only go forward, and question 1 is now above this question/)).toBeInTheDocument()
  })

  it('asks for a value when a rule has none, and names a removed option', () => {
    renderWithDraft(<LogicSection questionId="q_reason" />,
      formOf([reason([rule('equals', undefined, 'q_last'), rule('equals', 'gone', 'q_last')]), followUp, last]))
    expect(screen.getByText('Choose an option.')).toBeInTheDocument()
    expect(screen.getByText('“gone” is no longer an option. Choose another, or delete this rule.')).toBeInTheDocument()
  })

  it('says a number is outside the scale', () => {
    const score: Question = { id: 'q_score', type: 'rating', headline: { en: 'Rate it' }, required: true, scale: 'number', range: 5, logic: [rule('lte', 7, 'q_last')] }
    renderWithDraft(<LogicSection questionId="q_score" />, formOf([score, followUp, last]))
    expect(screen.getByText("7 is outside this question's 1–5 scale.")).toBeInTheDocument()
  })

  it('warns that skipped never runs on a required question, and that a repeated rule never runs', () => {
    renderWithDraft(<LogicSection questionId="q_reason" />,
      formOf([reason([rule('skipped', undefined, 'q_last'), rule('equals', 'price', 'q_last'), rule('equals', 'price', 'end_bye')]), followUp, last]))
    expect(screen.getByText('This question is required, so it is never skipped: this rule never runs.')).toBeInTheDocument()
    expect(screen.getByText('This rule never runs: rule 2 already matches every answer it would.')).toBeInTheDocument()
  })

  it('adds a rule with the type’s most likely operator and focuses its value', async () => {
    const user = userEvent.setup()
    const score: Question = { id: 'q_score', type: 'nps', headline: { en: 'Recommend us?' }, required: true }
    const harness = renderWithDraft(<LogicSection questionId="q_score" />, formOf([score, followUp, last]))
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(logicOf(harness.probe.current?.form, 'q_score')).toStrictEqual([{ when: { op: 'lte' }, then: { jump_to: 'q_last' } }])
    expect(screen.getByRole('combobox', { name: 'Rule 1: value' })).toHaveFocus()
  })

  it('writes a value as the option’s code while the select shows its label', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LogicSection questionId="q_reason" />, formOf([reason([rule('equals', undefined, 'q_last')]), followUp, last]))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rule 1: value' }), 'Missing features')
    expect(logicOf(harness.probe.current?.form, 'q_reason')).toStrictEqual([rule('equals', 'missing', 'q_last')])
  })

  it('stores Otherwise as a trailing submitted and skipped pair on an optional question, and reads it back', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LogicSection questionId="q_reason" />, formOf([reason([rule('equals', 'price', 'q_price')], false), followUp, last]))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Otherwise' }), 'Ending: Goodbye')
    expect(logicOf(harness.probe.current?.form, 'q_reason')).toStrictEqual([
      rule('equals', 'price', 'q_price'), rule('submitted', undefined, 'end_bye'), rule('skipped', undefined, 'end_bye'),
    ])
    expect(screen.getByRole('combobox', { name: 'Otherwise' })).toHaveValue('end_bye')
  })

  it('stores Otherwise as one submitted rule on a required question, and Next question removes it', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LogicSection questionId="q_reason" />, formOf([reason(), followUp, last]))
    const otherwise = screen.getByRole('combobox', { name: 'Otherwise' })
    await user.selectOptions(otherwise, '3 · Anything else?')
    expect(logicOf(harness.probe.current?.form, 'q_reason')).toStrictEqual([rule('submitted', undefined, 'q_last')])
    await user.selectOptions(otherwise, 'Next question: 2 · What price is fair?')
    expect(logicOf(harness.probe.current?.form, 'q_reason')).toBeUndefined()
  })

  it('moves a focused rule with Alt+Shift+↓ and says so', () => {
    const harness = renderWithDraft(<LogicSection questionId="q_reason" />,
      formOf([reason([rule('equals', 'price', 'q_price'), rule('equals', 'missing', 'q_last')]), followUp, last]))
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Rule 1: operator' }), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(logicOf(harness.probe.current?.form, 'q_reason')).toStrictEqual([rule('equals', 'missing', 'q_last'), rule('equals', 'price', 'q_price')])
    expect(screen.getByRole('status')).toHaveTextContent('Moved rule 1 to position 2 of 2.')
  })

  it('offers only "Then go to" on a statement, and lists no earlier question as a target', () => {
    const statement: Question = { id: 'q_note', type: 'statement', headline: { en: 'Read this' }, required: false }
    renderWithDraft(<LogicSection questionId="q_note" />, formOf([followUp, statement, last]))
    const target = screen.getByRole('combobox', { name: 'Then go to' })
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument()
    expect(within(target).queryByRole('option', { name: /What price is fair/ })).not.toBeInTheDocument()
  })
})
