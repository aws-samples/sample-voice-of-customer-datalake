import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChoiceQuestion, FormV2, Question } from '../model/formsV2'
import { formDiff } from '../model/formDiff'
import { sampleForm } from '../test/draftHarness'
import FormChangeRow from './FormChangeRow'
import type { ChangeRowProps } from './FormChangeRow'

const reason: ChoiceQuestion = {
  id: 'q_reason', type: 'single_select', headline: { en: 'Why?' }, required: true,
  options: [{ code: 'price', label: { en: 'Price' } }], other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
}
const toBugs = { when: { op: 'equals', value: 'bugs' }, then: { jump_to: 'end_thanks' } } as const
const more: Question = { id: 'q_more', type: 'statement', headline: { en: 'Read more' }, required: false, cta: { label: { en: 'Our plans' }, url: 'https://example.com/a' } }
const contact: Question = {
  id: 'q_contact', type: 'contact_info', headline: { en: 'Where can we reach you?' }, required: false,
  fields: { name: { show: true, required: false }, email: { show: true, required: true }, phone: { show: false, required: false }, company: { show: false, required: false } },
}

const withQuestions = (...questions: Question[]): FormV2 => sampleForm({ questions: [...sampleForm().questions, ...questions] })

/** Render the change `key` from `before` to `after`, expanded and accepted unless `props` say otherwise. */
function renderChange(before: FormV2, after: FormV2, key: string, props: Partial<ChangeRowProps> = {}) {
  const change = formDiff(before, after).changes.find((candidate) => candidate.key === key)
  if (change === undefined) throw new Error(`No change ${key}`)
  const spies = { onAccept: vi.fn<(accepted: boolean) => void>(), onExpand: vi.fn<(expanded: boolean) => void>(), onCheck: vi.fn<(url: string, checked: boolean) => void>() }
  render(
    <ul>
      <FormChangeRow change={change} before={before} after={after} accepted expanded checked={new Set()} dependency={null} {...spies} {...props} />
    </ul>,
  )
  return { user: userEvent.setup(), ...spies }
}

/** Each changed field the row shows: its name, and its before and after as read aloud. */
function shownFields(): Record<string, string[]> {
  return Object.fromEntries(screen.getAllByRole('term').map((term) => [
    term.textContent, [...(term.nextElementSibling?.querySelectorAll('p') ?? [])].map((line) => line.textContent),
  ]))
}

describe('FormChangeRow', () => {
  it('words each changed field of a question before and after, and a new rule as a sentence', () => {
    const after: ChoiceQuestion = {
      ...reason, headline: { en: 'Why are you leaving?' }, required: false, display: 'dropdown', logic: [toBugs],
      options: [...reason.options, { code: 'bugs', label: { en: 'Bugs' } }], other: { enabled: true, label: { en: 'Something else' } },
    }
    renderChange(withQuestions(reason), withQuestions(after), 'question:q_reason')
    expect(shownFields()).toStrictEqual({
      Question: ['Before: Why?', 'After: Why are you leaving?'],
      Required: ['Before: Yes', 'After: No'],
      Options: ['Before: Price', 'After: Price · Bugs'],
      Other: ['Before: No', 'After: Something else'],
      'Show as': ['Before: list', 'After: dropdown'],
      Logic: ['Rule added: If the answer is “Bugs” → Ending: Thank you!'],
    })
  })

  it('words a rule the change takes away', () => {
    const routed: ChoiceQuestion = { ...reason, options: [...reason.options, { code: 'bugs', label: { en: 'Bugs' } }], logic: [toBugs] }
    renderChange(withQuestions(routed), withQuestions({ ...routed, logic: undefined }), 'question:q_reason')
    expect(shownFields()).toStrictEqual({ Logic: ['Rule removed: If the answer is “Bugs” → Ending: Thank you!'] })
  })

  it('words a number set where there was none', () => {
    const limited: Question = { id: 'q_feedback', type: 'open_text', headline: { en: 'What would you like to tell us?' }, required: true, long: true, input_type: 'text', max_chars: 500 }
    renderChange(sampleForm(), sampleForm({ questions: [limited] }), 'question:q_feedback')
    expect(shownFields()).toStrictEqual({ Limit: ['Before: —', 'After: 500'] })
  })

  it('shows a group of settings it has no words for as it is', () => {
    const fields = { ...contact.fields, phone: { show: true, required: false } }
    renderChange(withQuestions(contact), withQuestions({ ...contact, fields }), 'question:q_contact')
    expect(shownFields()['Fields']).toStrictEqual([`Before: ${JSON.stringify(contact.fields)}`, `After: ${JSON.stringify(fields)}`])
  })

  it('holds a change that brings in an address until the person checked it', async () => {
    const moved: Question = { ...more, cta: { label: { en: 'Our plans' }, url: 'https://example.com/b' } }
    const { user, onCheck } = renderChange(withQuestions(more), withQuestions(moved), 'question:q_more')
    expect(shownFields()).toStrictEqual({ 'Link button': ['Before: Our plans (https://example.com/a)', 'After: Our plans (https://example.com/b)'] })
    expect(screen.getByText('Not applied until you confirm the address.')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: (name) => name.startsWith('https://example.com/b') }))
    expect(onCheck).toHaveBeenCalledWith('https://example.com/b', true)
  })

  it('says a rejected change is not applied, and what goes with it', async () => {
    const { user, onAccept } = renderChange(withQuestions(reason), withQuestions(), 'question:q_reason', {
      accepted: false, dependency: 'Kept with it: the rules on 1 that go to it.',
    })
    expect(screen.getByText('not applied')).toBeInTheDocument()
    expect(screen.getByText('Kept with it: the rules on 1 that go to it.')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Apply: Removed question 2' }))
    expect(onAccept).toHaveBeenCalledWith(true)
  })

  it('shows what changed on demand', async () => {
    const { user, onExpand } = renderChange(withQuestions(reason), withQuestions({ ...reason, required: false }), 'question:q_reason', { expanded: false })
    expect(screen.queryByRole('term')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show what changed' }))
    expect(onExpand).toHaveBeenCalledWith(true)
  })

  const polish = sampleForm({
    languages: ['en', 'pl'],
    questions: [{ id: 'q_feedback', type: 'open_text', headline: { en: 'What would you like to tell us?', pl: 'Co chcesz nam powiedzieć?' }, required: true, long: true, input_type: 'text' }],
  })
  const bye = sampleForm({ endings: [...sampleForm().endings, { id: 'end_bye', title: { en: 'Bye' }, button: { label: { en: 'Home' }, url: 'https://example.com' } }] })
  const welcomed = sampleForm({ welcome: { enabled: true, title: { en: 'Hello' } } })

  it.each([
    ['an added ending', sampleForm(), bye, 'ending:end_bye', 'Apply: Added ending “Bye”', 'Bye'],
    ['a removed hidden field', sampleForm({ hidden_fields: [{ id: 'plan' }] }), sampleForm(), 'hidden:plan', 'Apply: Removed hidden field plan', 'Hidden field plan'],
    ['an added language', sampleForm(), polish, 'language:pl', 'Apply: Added language Polski', 'Polski · 1 text'],
    ['a removed language', polish, sampleForm(), 'language:pl', 'Apply: Removed language Polski', 'Polski'],
    ['the welcome card', sampleForm(), welcomed, 'welcome', 'Apply: Changed the welcome card', 'Welcome card'],
  ])('names %s by what it is', (_name, before, after, key, label, headline) => {
    renderChange(before, after, key, { expanded: false })
    expect(screen.getByRole('checkbox', { name: label })).toBeChecked()
    expect(screen.getByText(headline)).toBeInTheDocument()
  })

  it('words a switch and a text of the welcome card', () => {
    renderChange(sampleForm(), sampleForm({ welcome: { enabled: true, title: { en: 'Hello' } } }), 'welcome')
    expect(shownFields()).toStrictEqual({ Shown: ['Before: No', 'After: Yes'], Title: ['Before: —', 'After: Hello'] })
  })
})
