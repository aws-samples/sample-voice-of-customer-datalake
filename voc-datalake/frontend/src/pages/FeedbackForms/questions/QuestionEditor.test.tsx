import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubElementScrollIntoView } from '../../../test/stubScrollTo'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { useDraft } from '../builder/formDraftContext'
import type { ChoiceQuestion, FormV2, Question } from '../model/formsV2'
import QuestionEditor from './QuestionEditor'
import { requestFocus } from './focusRequest'

vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

/** The editor of the question at `at`, read from the draft on every render (as the Questions tab gives it). */
function EditorAt({ at }: Readonly<{ at: number }>) {
  const question = useDraft().form.questions[at]
  return question === undefined ? null : <QuestionEditor question={question} index={at} />
}

const open = (id: string, headline: string): Question => ({ id, type: 'open_text', headline: { en: headline }, required: false, long: true, input_type: 'text' })

const picked: ChoiceQuestion = {
  id: 'q_picked', type: 'multi_select', headline: { en: 'What did you use?' }, required: true,
  options: [{ code: 'app', label: { en: 'The app' } }, { code: 'site', label: { en: 'The website' } }],
  other: { enabled: false }, none: { enabled: true }, shuffle: 'none', display: 'auto',
}

const twoTexts = (): FormV2 => sampleForm({ questions: [open('q_first', 'What brought you here?'), open('q_second', 'Anything else?')] })

const firstOf = (form: FormV2 | undefined): Question | undefined => form?.questions[0]

describe('QuestionEditor: the common fields', () => {
  it('writes the question, its description and Required', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />)
    await user.type(screen.getByRole('textbox', { name: 'Question' }), ' Please')
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Be honest')
    await user.click(screen.getByRole('switch', { name: 'Required' }))
    const question = firstOf(harness.probe.current?.form)
    expect(question?.headline).toStrictEqual({ en: 'What would you like to tell us? Please' })
    expect(question?.subheader).toStrictEqual({ en: 'Be honest' })
    expect(question?.required).toBe(false)
  })

  it("writes the button label under Advanced, Show codes being a choice's only", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />)
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.type(screen.getByRole('textbox', { name: 'Button label' }), 'Go on')
    expect(firstOf(harness.probe.current?.form)?.button_label).toStrictEqual({ en: 'Go on' })
    expect(screen.queryByRole('switch', { name: /^Show codes/ })).not.toBeInTheDocument()
  })

  it("shows a choice's codes when Show codes is on", async () => {
    const user = userEvent.setup()
    renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [picked] }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.click(screen.getByRole('switch', { name: /^Show codes/ }))
    expect(screen.getByRole('textbox', { name: 'Code of option 2' })).toHaveValue('site')
  })

  it('says a scale is never skipped when Required', () => {
    renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [{ id: 'q_nps', type: 'nps', headline: { en: 'Would you recommend us?' }, required: true }] }))
    expect(screen.getByText("Respondents can't skip it.")).toBeInTheDocument()
  })
})

describe('QuestionEditor: Edit in Logic', () => {
  beforeEach(() => stubElementScrollIntoView())

  it('opens the Logic section and brings it into view from an option a broader rule routes', async () => {
    const user = userEvent.setup()
    const question: ChoiceQuestion = { ...picked, logic: [{ when: { op: 'includes_all', value: ['app'] }, then: { jump_to: 'end_thanks' } }] }
    renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [question] }))
    await user.click(screen.getByRole('button', { name: 'Logic · 1 rule' }))
    expect(screen.getByRole('button', { name: 'Logic · 1 rule' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'Routing' }))
    await user.click(screen.getByRole('button', { name: 'Edit in Logic' }))
    expect(screen.getByRole('button', { name: 'Logic · 1 rule' })).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => { expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }) })
  })
})

describe('QuestionEditor: the question id', () => {
  it('renames the question when the field is left, and moves the address to the new id', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />)
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    const field = screen.getByRole('textbox', { name: 'Question id' })
    await user.clear(field)
    await user.type(field, 'q_topic')
    await user.tab()
    expect(firstOf(harness.probe.current?.form)?.id).toBe('q_topic')
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_topic'], { replace: true })
  })

  it('applies a typed id on Enter', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />)
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.type(screen.getByRole('textbox', { name: 'Question id' }), '_2{Enter}')
    expect(firstOf(harness.probe.current?.form)?.id).toBe('q_feedback_2')
  })

  it('says what is wrong with a typed id, and keeps the old one when the field is left', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />)
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    const field = screen.getByRole('textbox', { name: 'Question id' })
    await user.type(field, '-X')
    expect(screen.getByRole('alert')).toHaveTextContent('A question id starts with q_ and uses lower-case letters, digits and _.')
    await user.tab()
    expect(field).toHaveValue('q_feedback')
    expect(firstOf(harness.probe.current?.form)?.id).toBe('q_feedback')
  })

  it("refuses another question's id", async () => {
    const user = userEvent.setup()
    renderWithDraft(<EditorAt at={1} />, twoTexts())
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    const field = screen.getByRole('textbox', { name: 'Question id' })
    await user.clear(field)
    await user.type(field, 'q_first')
    expect(screen.getByRole('alert')).toHaveTextContent('Another question has the id q_first.')
  })

  it("refuses a removed question's id: ids are never reused", async () => {
    const user = userEvent.setup()
    renderWithDraft(<EditorAt at={0} />, sampleForm(), { meta: { retired_ids: ['q_old'] } })
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    const field = screen.getByRole('textbox', { name: 'Question id' })
    await user.clear(field)
    await user.type(field, 'q_old')
    expect(screen.getByRole('alert')).toHaveTextContent('The id q_old belonged to a question removed earlier, and ids are never reused. Choose another.')
  })

  it('shows the id read-only, with the reason, once the form has responses', async () => {
    const user = userEvent.setup()
    renderWithDraft(<EditorAt at={0} />, sampleForm(), { meta: { has_responses: true, response_count: 2 } })
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.queryByRole('textbox', { name: 'Question id' })).not.toBeInTheDocument()
    expect(screen.getByText('q_feedback')).toBeInTheDocument()
    expect(screen.getByText("Answers are stored under this id, so it can't change once there are responses.")).toBeInTheDocument()
  })
})

describe('QuestionEditor: the header', () => {
  it('duplicates the question and opens the copy', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />)
    await user.click(screen.getByRole('button', { name: 'Duplicate question 1' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_feedback', 'q_feedback_2'])
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_feedback_2'])
  })

  it("never gives a copy a removed question's id", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />, sampleForm(), { meta: { retired_ids: ['q_feedback_2'] } })
    await user.click(screen.getByRole('button', { name: 'Duplicate question 1' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_feedback', 'q_feedback_3'])
  })

  it('moves the question down from its menu, Move up being off on the first', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />, twoTexts())
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    expect(screen.getByRole('menuitem', { name: /^Move up/ })).toHaveTextContent("It's already first.")
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_second', 'q_first'])
  })

  it('moves the last question up from its menu', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={1} />, twoTexts())
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_second', 'q_first'])
  })

  it('deletes a question nothing points to at once', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={1} />, twoTexts())
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_first'])
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_first'], { replace: true })
  })

  it('asks before deleting a question with answers and a rule pointing to it', async () => {
    const user = userEvent.setup()
    const form = twoTexts()
    const first = { ...open('q_first', 'What brought you here?'), logic: [{ when: { op: 'submitted' as const }, then: { jump_to: 'q_second' } }] }
    const harness = renderWithDraft(<EditorAt at={1} />, { ...form, questions: [first, ...form.questions.slice(1)] }, { meta: { has_responses: true, response_count: 4 } })
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '1 rule goes to this question. It will be removed, and those respondents will go to the next question. Its answers stay in Results under “Removed questions”.')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_first'])
  })

  it('keeps the question when the delete is cancelled', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={1} />, twoTexts(), { meta: { has_responses: true, response_count: 4 } })
    await user.click(screen.getByRole('button', { name: 'More actions for question 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Its answers stay in Results under “Removed questions”.')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(harness.probe.current?.form.questions).toHaveLength(2)
  })
})

describe('QuestionEditor: the type select', () => {
  it('asks before a change that drops something, and keeps the question on Cancel', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [picked] }))
    await user.selectOptions(screen.getByRole('combobox', { name: /Question 1: type/ }), 'Single choice')
    expect(screen.getByRole('dialog')).toHaveTextContent('This change drops: the “None of these” row.')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(firstOf(harness.probe.current?.form)?.type).toBe('multi_select')
  })

  it('changes the type once the change is confirmed', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [{ ...picked, min: 1, max: 2 }] }))
    await user.selectOptions(screen.getByRole('combobox', { name: /Question 1: type/ }), 'Single choice')
    expect(screen.getByRole('dialog')).toHaveTextContent('This change drops: the “None of these” row · At least and At most.')
    await user.click(screen.getByRole('button', { name: 'Change type' }))
    expect(firstOf(harness.probe.current?.form)).toMatchObject({ type: 'single_select', none: { enabled: false } })
  })

  it('says a question with no conversion keeps its type', () => {
    renderWithDraft(<EditorAt at={0} />)
    expect(screen.queryByRole('combobox', { name: /Question 1: type/ })).not.toBeInTheDocument()
    expect(screen.getByText('To change its type, add a new question of that type and delete this one.')).toBeInTheDocument()
  })

  it("keeps an answered question's type, saying why, and offers no other", () => {
    renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [picked] }), { meta: { has_responses: true, response_count: 3 } })
    expect(screen.queryByRole('combobox', { name: /Question 1: type/ })).not.toBeInTheDocument()
    expect(screen.getByText(/^Answers are stored for this type, so it can't change once the form has responses\./u)).toBeInTheDocument()
  })

  it('offers an answered question only its way back to the stored type', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [picked] }), { meta: { has_responses: true } })
    // (changed before the lock was known: the form got its first response while this draft was open)
    act(() => { harness.probe.current?.update((form) => ({ ...form, questions: [{ ...picked, type: 'single_select', none: { enabled: false } }] })) })
    const select = await screen.findByRole('combobox', { name: /Question 1: type/ })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['Single choice', 'Multiple choice'])
    await user.selectOptions(select, 'Multiple choice')
    expect(firstOf(harness.probe.current?.form)?.type).toBe('multi_select')
  })

  it('lets a question added since the first response change its type', async () => {
    const harness = renderWithDraft(<EditorAt at={1} />, sampleForm({ questions: [open('q_first', 'Hi')] }), { meta: { has_responses: true } })
    act(() => { harness.probe.current?.update((form) => ({ ...form, questions: [...form.questions, picked] })) })
    expect(await screen.findByRole('combobox', { name: /Question 2: type/ })).toBeInTheDocument()
  })

  it('focuses the type select when Change type… asked for it', () => {
    requestFocus('type:q_picked')
    renderWithDraft(<EditorAt at={0} />, sampleForm({ questions: [picked] }))
    expect(screen.getByRole('combobox', { name: /Question 1: type/ })).toHaveFocus()
  })
})

// (the line a missing translation shows, and its Translate, are editors.test.tsx's)
describe('QuestionEditor: a missing translation', () => {
  it('says nothing when every language has the texts', () => {
    const question = open('q_feedback', 'Tell us')
    renderWithDraft(<EditorAt at={0} />, sampleForm({ languages: ['en', 'pl'], questions: [{ ...question, headline: { en: 'Tell us', pl: 'Powiedz nam' } }] }))
    expect(screen.queryByRole('button', { name: /^Translate into/ })).not.toBeInTheDocument()
  })
})
