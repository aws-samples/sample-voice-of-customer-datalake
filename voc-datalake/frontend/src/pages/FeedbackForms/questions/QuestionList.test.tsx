import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { DraftHarnessOptions } from '../test/draftHarness'
import type { Ending, FormV2, Question } from '../model/formsV2'
import QuestionList from './QuestionList'
import StatusLineProvider from './statusLine'

const text = (id: string, headline: string): Question => ({ id, type: 'open_text', headline: { en: headline }, required: false, long: true, input_type: 'text' })

const reason: Question = {
  id: 'q_reason', type: 'single_select', headline: { en: 'Why are you leaving?' }, required: true,
  options: [{ code: 'price', label: { en: 'Too expensive' } }], other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
  logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'q_price' } }],
}

const threeQuestions = (): FormV2 => sampleForm({ questions: [reason, text('q_middle', 'Anything else?'), text('q_price', 'What price is fair?')] })

function renderList(form: FormV2, options: DraftHarnessOptions = {}) {
  const onSelect = vi.fn()
  const harness = renderWithDraft(<StatusLineProvider><QuestionList selected={null} onSelect={onSelect} /></StatusLineProvider>, form, options)
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

  it("never gives a new question a removed question's id, nor one this draft removed", async () => {
    const user = userEvent.setup()
    const { probe } = renderList(sampleForm({ questions: [text('q_feedback', 'Hi'), text('q_open_text', 'Gone soon')] }), { meta: { retired_ids: ['q_open_text_2'] } })
    act(() => { probe.current?.update((form) => ({ ...form, questions: form.questions.slice(0, 1) })) })
    await user.click(screen.getByRole('button', { name: 'Add question' }))
    await user.click(screen.getByRole('menuitem', { name: /^Text/ }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_feedback', 'q_open_text_3'])
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

describe('QuestionList: more of the list', () => {
  it('opens a question to change its type from its menu', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    await user.click(screen.getByRole('menuitem', { name: 'Change type…' }))
    expect(onSelect).toHaveBeenCalledWith({ kind: 'question', id: 'q_reason' })
  })

  it("says a text question's type can't change", async () => {
    const user = userEvent.setup()
    renderList(threeQuestions())
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    expect(screen.getByRole('menuitem', { name: /^Change type…/ })).toHaveTextContent('To change its type, add a new question of that type and delete this one.')
  })

  it('opens the welcome card, and says whether it is on', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList(sampleForm({ welcome: { enabled: true, title: { en: 'Hi' } } }))
    await user.click(screen.getByRole('button', { name: 'Welcome screen On' }))
    expect(onSelect).toHaveBeenCalledWith({ kind: 'welcome', id: 'welcome' })
  })

  it('opens Improve with AI', async () => {
    const user = userEvent.setup()
    const { openImprove } = renderList(sampleForm())
    await user.click(screen.getByRole('button', { name: 'Improve with AI' }))
    expect(openImprove).toHaveBeenCalledTimes(1)
  })

  it('moves a question dropped on another card', () => {
    const { probe } = renderList(threeQuestions())
    fireEvent.dragStart(screen.getByTestId('grip-q_reason'))
    fireEvent.dragOver(screen.getByRole('button', { name: /Question 3 of 3/ }))
    fireEvent.drop(screen.getByRole('button', { name: /Question 3 of 3/ }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_middle', 'q_price', 'q_reason'])
  })

  it('moves nothing when a question is dropped on an ending, or the drag is let go', () => {
    const { probe } = renderList(threeQuestions())
    fireEvent.dragStart(screen.getByTestId('grip-q_reason'))
    fireEvent.dragOver(screen.getByRole('button', { name: /^Thank you!/ }))
    fireEvent.drop(screen.getByRole('button', { name: /^Thank you!/ }))
    fireEvent.dragStart(screen.getByTestId('grip-q_middle'))
    fireEvent.dragEnd(screen.getByTestId('grip-q_middle'))
    fireEvent.drop(screen.getByRole('button', { name: /Question 3 of 3/ }))
    expect(ids(probe.current?.form)).toStrictEqual(['q_reason', 'q_middle', 'q_price'])
  })

  it('says why it holds no more than 30 questions', async () => {
    const user = userEvent.setup()
    const thirty = Array.from({ length: 30 }, (_unused, n) => text(`q_${String(n)}`, `Question ${String(n)}`))
    renderList(sampleForm({ questions: thirty }))
    expect(screen.getByText('A form holds up to 30 questions.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add question after question/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    expect(screen.getByRole('menuitem', { name: /^Duplicate/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('asks before deleting a question that may have answers', async () => {
    const user = userEvent.setup()
    renderList(threeQuestions(), { meta: { has_responses: true, response_count: 5 } })
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Its answers stay in Results under “Removed questions”.')
  })
})

describe("QuestionList: a card's meta line", () => {
  it('says a choice’s options, Other and None, and a text’s length and limit', () => {
    const multi: Question = { ...reason, type: 'multi_select', logic: undefined, other: { enabled: true }, none: { enabled: true } }
    const short: Question = { id: 'q_short', type: 'open_text', headline: { en: 'Your name?' }, required: false, long: false, input_type: 'text', max_chars: 80 }
    renderList(sampleForm({ questions: [multi, short] }))
    expect(screen.getByRole('button', { name: /Question 1 of 2/ })).toHaveTextContent('1 option · Other · None · Required')
    expect(screen.getByRole('button', { name: /Question 2 of 2/ })).toHaveTextContent('Short text · up to 80 characters')
  })

  it("says a rating's scale and a score's range", () => {
    renderList(sampleForm({
      questions: [
        { id: 'q_stars', type: 'rating', headline: { en: 'Rate us' }, required: true, scale: 'star', range: 5 },
        { id: 'q_nps', type: 'nps', headline: { en: 'Recommend us?' }, required: false },
      ],
    }))
    expect(screen.getByRole('button', { name: /Question 1 of 2/ })).toHaveTextContent('1–5 stars · Required')
    expect(screen.getByRole('button', { name: /Question 2 of 2/ })).toHaveTextContent('0–10')
  })

  it('says whether a statement has a link and a consent must be ticked', () => {
    renderList(sampleForm({
      questions: [
        { id: 'q_note', type: 'statement', headline: { en: 'Thanks' }, required: false },
        { id: 'q_link', type: 'statement', headline: { en: 'Read' }, required: false, cta: { label: { en: 'Terms' }, url: 'https://example.com' } },
        { id: 'q_ok', type: 'consent', headline: { en: 'Agree?' }, required: true, label: { en: 'I agree' } },
        { id: 'q_maybe', type: 'consent', headline: { en: 'News?' }, required: false, label: { en: 'Send news' } },
      ],
    }))
    expect(screen.getByRole('button', { name: /Question 1 of 4/ })).toHaveTextContent('Text only')
    expect(screen.getByRole('button', { name: /Question 2 of 4/ })).toHaveTextContent('With a link button')
    expect(screen.getByRole('button', { name: /Question 3 of 4/ })).toHaveTextContent('Must be ticked to continue')
    expect(screen.getByRole('button', { name: /Question 4 of 4/ })).toHaveTextContent('Optional')
  })

  it('names the contact fields a contact question shows', () => {
    renderList(sampleForm({
      questions: [{
        id: 'q_contact', type: 'contact_info', headline: { en: 'Where can we reach you?' }, required: true,
        fields: { name: { show: true, required: false }, email: { show: false, required: false }, phone: { show: true, required: true }, company: { show: false, required: false } },
      }],
    }))
    expect(screen.getByRole('button', { name: /Question 1 of 1/ })).toHaveTextContent('Name · Phone · Required')
  })
})

describe('QuestionList: the endings', () => {
  const ending = (id: string, title: string): Ending => ({ id, title: { en: title } })

  const threeEndings = (): FormV2 => sampleForm({ endings: [ending('end_thanks', 'Thank you!'), ending('end_sorry', 'Sorry'), ending('end_later', 'See you')] })

  it('opens an ending, the first being the default', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList(threeEndings())
    expect(screen.getByRole('button', { name: /^Thank you!/ })).toHaveTextContent('default')
    await user.click(screen.getByRole('button', { name: /^Sorry/ }))
    expect(onSelect).toHaveBeenCalledWith({ kind: 'ending', id: 'end_sorry' })
  })

  it('adds an ending and opens it', async () => {
    const user = userEvent.setup()
    const { probe, go } = renderList(sampleForm())
    await user.click(screen.getByRole('button', { name: 'Add ending' }))
    expect(probe.current?.form.endings.at(-1)).toStrictEqual({ id: 'end_thanks_2', title: { en: 'Thank you' } })
    expect(go).toHaveBeenCalledWith('questions', ['end', 'end_thanks_2'])
  })

  it('says a new default ending when the first one moves down', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeEndings())
    await user.click(screen.getByRole('button', { name: 'More actions for ending “Thank you!”' }))
    expect(screen.getByRole('menuitem', { name: /^Move up/ })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }))
    expect(probe.current?.form.endings.map((e) => e.id)).toStrictEqual(['end_sorry', 'end_thanks', 'end_later'])
    expect(screen.getByRole('status')).toHaveTextContent('“Sorry” is now the default ending.')
  })

  it('says where an ending moved up to', async () => {
    const user = userEvent.setup()
    const { probe } = renderList(threeEndings())
    await user.click(screen.getByRole('button', { name: 'More actions for ending “See you”' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }))
    expect(probe.current?.form.endings.map((e) => e.id)).toStrictEqual(['end_thanks', 'end_later', 'end_sorry'])
    expect(screen.getByRole('status')).toHaveTextContent('Moved “See you” to position 2 of 3.')
  })

  it('asks before deleting an ending a rule ends at, then deletes it', async () => {
    const user = userEvent.setup()
    const form = threeEndings()
    const routed = { ...text('q_feedback', 'Tell us'), logic: [{ when: { op: 'submitted' as const }, then: { jump_to: 'end_sorry' } }] }
    const { probe } = renderList({ ...form, questions: [routed] })
    await user.click(screen.getByRole('button', { name: 'More actions for ending “Sorry”' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete this ending?')
    expect(screen.getByRole('dialog')).toHaveTextContent('1 rule ends here. It will be removed, and those respondents will see the default ending.')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(probe.current?.form.endings.map((e) => e.id)).toStrictEqual(['end_thanks', 'end_later'])
  })

  it("won't delete the last ending, and says why", async () => {
    const user = userEvent.setup()
    renderList(sampleForm())
    await user.click(screen.getByRole('button', { name: 'More actions for ending “Thank you!”' }))
    expect(screen.getByRole('menuitem', { name: /^Delete…/ })).toHaveTextContent('A form needs at least one ending.')
  })

  it('says why it holds no more than 5 endings', async () => {
    const user = userEvent.setup()
    const five = Array.from({ length: 5 }, (_unused, n) => ending(`end_${String(n)}`, `Ending ${String(n)}`))
    const { probe } = renderList(sampleForm({ endings: five }))
    expect(screen.getByText('A form has up to 5 endings.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add ending' }))
    expect(probe.current?.form.endings).toHaveLength(5)
  })
})
