import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import LiveQuestionEditor from '../test/LiveQuestionEditor'
import type { FormV2, Question } from '../model/formsV2'
import WelcomeEditor from './WelcomeEditor'
import EndingEditor from './EndingEditor'

vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

const en = (text: string) => ({ en: text })
const nps: Question = { id: 'q_nps', type: 'nps', headline: en('How likely are you to recommend us?'), required: true }
const reason: Question = { id: 'q_reason', type: 'open_text', headline: en('Why?'), required: false, long: true, input_type: 'text' }
const pick: Question = {
  id: 'q_pick', type: 'single_select', headline: en('Pick one'), required: true, options: [{ code: 'a', label: en('A') }],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
}
const recallForm = (questions: readonly Question[] = [nps, reason, pick], extra: Partial<FormV2> = {}): FormV2 =>
  sampleForm({ questions, hidden_fields: [{ id: 'event', label: 'Event' }, { id: 'user_id' }], ...extra })


async function openInsert(user: ReturnType<typeof userEvent.setup>, index = 0) {
  const triggers = screen.getAllByRole('button', { name: 'Insert a value' })
  const trigger = triggers[index]
  if (trigger === undefined) throw new Error('no Insert a value menu')
  await user.click(trigger)
  return screen.getByRole('menu', { name: 'Insert a value' })
}

describe('Insert a value', () => {
  it('offers the hidden fields, then the earlier scores and single choices, never an open text', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveQuestionEditor id="q_pick" />, recallForm())
    const menu = await openInsert(user)
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual([
      'Hidden field · Event', 'Hidden field · user_id', 'Q1 · How likely are you to recommend us?',
    ])
  })

  it('inserts {{id}} where the caret is', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveQuestionEditor id="q_pick" />, recallForm())
    const headline = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Question' })
    act(() => {
      headline.focus()
      headline.setSelectionRange(4, 4)
    })
    const menu = await openInsert(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Hidden field · Event' }))
    expect(harness.probe.current?.form.questions[2]?.headline).toStrictEqual(en('Pick{{event}} one'))
  })

  it('says why there is nothing to insert in the welcome of a form without hidden fields', async () => {
    const user = userEvent.setup()
    renderWithDraft(<WelcomeEditor />, sampleForm({ welcome: { enabled: true, title: en('Hello') } }))
    const menu = await openInsert(user)
    expect(within(menu).getByRole('menuitem')).toHaveTextContent('Add a hidden field, or a score or single-choice question before this text.')
  })

  it('is on the recall texts only, never on an option, a button or a placeholder', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveQuestionEditor id="q_pick" />, recallForm())
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    // (the headline and the description: not the option, nor the button label under Advanced)
    expect(screen.getAllByRole('button', { name: 'Insert a value' })).toHaveLength(2)
  })
})

describe('the recall preview', () => {
  it('shows the text with each value named, and without one as the widget tidies it', () => {
    renderWithDraft(<LiveQuestionEditor id="q_pick" />, recallForm([nps, reason, { ...pick, headline: en('Thanks, {{event}}! You gave {{q_nps}}.') }]))
    expect(screen.getByText('Respondents see: Thanks, ‹Event›! You gave ‹How likely are you to recommend us?›.')).toBeInTheDocument()
    expect(screen.getByText('Without a value: Thanks! You gave.')).toBeInTheDocument()
  })

  it('previews an ending, which may recall every question, and says when nothing is left', () => {
    renderWithDraft(<EndingEditor ending={{ id: 'end_thanks', title: en('{{q_pick}}') }} />, recallForm())
    expect(screen.getByText('Respondents see: ‹Pick one›')).toBeInTheDocument()
    expect(screen.getByText('Without a value: (nothing)')).toBeInTheDocument()
  })

  it('previews only a text with a placeholder, and says when one names nothing', () => {
    renderWithDraft(<LiveQuestionEditor id="q_nps" />, recallForm([{ ...nps, subheader: en('About {{nobody}}') }, reason, pick]))
    expect(screen.getAllByText(/^Respondents see/).map((node) => node.textContent)).toStrictEqual(['Respondents see: About'])
    expect(screen.getByText('{{nobody}} names no hidden field and no question of this form (English).')).toBeInTheDocument()
  })
})
