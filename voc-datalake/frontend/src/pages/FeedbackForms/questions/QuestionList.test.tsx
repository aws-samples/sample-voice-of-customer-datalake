import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { FormV2, Question } from '../model/formsV2'
import QuestionList from './QuestionList'
import StatusLineProvider from './statusLine'

const text = (id: string, headline: string): Question => ({ id, type: 'open_text', headline: { en: headline }, required: false, long: true, input_type: 'text' })

const reason: Question = {
  id: 'q_reason', type: 'single_select', headline: { en: 'Why are you leaving?' }, required: true,
  options: [{ code: 'price', label: { en: 'Too expensive' } }], other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
  logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'q_price' } }],
}

const threeQuestions = (): FormV2 => sampleForm({ questions: [reason, text('q_middle', 'Anything else?'), text('q_price', 'What price is fair?')] })

function renderList(form: FormV2) {
  const onSelect = vi.fn()
  const harness = renderWithDraft(<StatusLineProvider><QuestionList selected={null} onSelect={onSelect} /></StatusLineProvider>, form)
  return { ...harness, onSelect }
}

const ids = (form: FormV2 | undefined) => form?.questions.map((q) => q.id)

describe('QuestionList', () => {
  it('adds a question of the picked type at the end and selects it', async () => {
    const user = userEvent.setup()
    const { probe, go } = renderList(sampleForm())
    await user.click(screen.getByRole('button', { name: 'Add question' }))
    await user.click(screen.getByRole('menuitem', { name: /^Single choice/ }))
    expect(probe.current?.form.questions.at(-1)?.type).toBe('single_select')
    expect(go).toHaveBeenCalledWith('questions', ['q_single_select'])
    expect(probe.current?.freshCodes).toStrictEqual(new Set(['q_single_select:option', 'q_single_select:option_2']))
  })

  it('opens the type menu outside the scrolling list (fixed, in a portal), and Escape goes back to the trigger', async () => {
    const user = userEvent.setup()
    const { container } = renderList(sampleForm())
    const add = screen.getByRole('button', { name: 'Add question' })
    await user.click(add)
    const menu = screen.getByRole('menu', { name: 'Question types' })
    expect(container).not.toContainElement(menu)
    expect(menu).toHaveClass('fixed')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(add).toHaveFocus()
  })

  it('moves through the types by their first letters (type-ahead), and End to the last', async () => {
    const user = userEvent.setup()
    renderList(sampleForm())
    await user.click(screen.getByRole('button', { name: 'Add question' }))
    await user.keyboard('c')
    expect(screen.getByRole('menuitem', { name: /^CSAT/ })).toHaveFocus()
    await user.keyboard('c')
    expect(screen.getByRole('menuitem', { name: /^CES/ })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: /^Contact info/ })).toHaveFocus()
  })

  it('inserts between two cards from the "+" of the line between them', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'Add question after question 1' }))
    await user.click(screen.getByRole('menuitem', { name: /^Text/ }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_open_text', 'q_middle', 'q_price'])
  })

  it('adds a question below a card from its ⋯ menu (no hover needed), under the last card too', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add question below' }))
    expect(screen.getByRole('menuitem', { name: /^Single choice/ })).toHaveFocus()
    await user.click(screen.getByRole('menuitem', { name: /^NPS/ }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_middle', 'q_nps', 'q_price'])
    await user.click(screen.getByRole('button', { name: 'More actions for question 4' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add question below' }))
    await user.click(screen.getByRole('menuitem', { name: /^Statement/ }))
    expect(ids(probe.current?.form)?.at(-1)).toBe('q_statement')
  })

  it('shows the welcome screen as a card with its state', () => {
    renderList(sampleForm({ welcome: { enabled: true, title: { en: 'Hello' } } }))
    expect(screen.getByRole('button', { name: 'Welcome screen On' })).toBeInTheDocument()
  })

  it('offers Contact info once per form', async () => {
    const user = userEvent.setup()
    const contact: Question = {
      id: 'q_contact', type: 'contact_info', headline: { en: 'Where can we reach you?' }, required: true,
      fields: { name: { show: true, required: false }, email: { show: true, required: true }, phone: { show: false, required: false }, company: { show: false, required: false } },
    }
    renderList(sampleForm({ questions: [text('q_feedback', 'Tell us'), contact] }))
    await user.click(screen.getByRole('button', { name: 'Add question' }))
    expect(screen.getByRole('menuitem', { name: /^Contact info/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: /^Contact info/ })).toHaveTextContent('Already in this form')
  })

  it('moves a question down from its menu, and says so', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_price', 'q_middle'])
    expect(screen.getByRole('status')).toHaveTextContent('Moved “Anything else?” to position 3 of 3.')
  })

  it('moves the focused card with Alt+Shift+ArrowDown', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    const list = screen.getByRole('list', { name: 'Questions' })
    within(list).getByRole('button', { name: /Question 1 of 3/ }).focus()
    await user.keyboard('{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}')
    expect(ids(probe.current?.form)).toStrictEqual(['q_middle', 'q_reason', 'q_price'])
  })

  it('asks before deleting a question rules jump to, then removes those rules', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 3' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('1 rule goes to this question. It will be removed, and those respondents will go to the next question.')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_middle'])
    expect(probe.current?.form.questions[0]?.logic).toBeUndefined()
  })

  it('deletes a question nothing points to at once, with Undo', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_price'])
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_middle', 'q_price'])
  })

  it('duplicates a question right after it, as <id>_2 with its rules', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_reason_2', 'q_middle', 'q_price'])
    expect(probe.current?.form.questions[1]?.logic).toStrictEqual(reason.logic)
  })

  it("won't delete the last question, and says why", async () => {
    const user = userEvent.setup()
    renderList(sampleForm())
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    const item = screen.getByRole('menuitem', { name: /^Delete…/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('A form needs at least one question.')
  })

  it('shows a card with a problem and one missing a translation', () => {
    const form = sampleForm({ languages: ['en', 'pl'], questions: [text('q_feedback', ''), text('q_other', 'Hello')] })
    renderList(form)
    expect(screen.getByRole('button', { name: /Question 1 of 2/ })).toHaveTextContent('Problem')
    expect(screen.getByRole('button', { name: /Question 2 of 2/ })).toHaveTextContent('pl missing')
  })
})
