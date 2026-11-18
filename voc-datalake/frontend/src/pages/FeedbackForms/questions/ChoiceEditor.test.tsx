import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { useDraft } from '../builder/formDraftContext'
import { isChoice } from '../model/formsV2'
import type { ChoiceQuestion, FormV2, Question } from '../model/formsV2'
import ChoiceEditor from './ChoiceEditor'

vi.mock('../../../hooks/useCategories', () => ({
  useCategoriesConfig: () => ({
    data: { categories: [{ id: 'cat_1', name: 'pricing', description: 'Pricing', subcategories: [{ id: 'sub_1', name: 'discounts', description: 'Discounts' }] }] },
  }),
}))

function choice(type: ChoiceQuestion['type'], codes: readonly string[], extra: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return {
    id: 'q_reason', type, headline: { en: 'Why?' }, required: true,
    options: codes.map((code) => ({ code, label: { en: code === 'price' ? "It's too expensive" : `Label ${code}` } })),
    other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto', ...extra,
  }
}

function formWith(question: Question): FormV2 {
  return sampleForm({
    questions: [question, { id: 'q_next', type: 'open_text', headline: { en: 'Tell us more' }, required: false, long: true, input_type: 'text' }],
  })
}

/** The editor of `q_reason`, read from the draft on every render (as the Questions tab gives it). */
function LiveChoice({ showCodes = false }: Readonly<{ showCodes?: boolean }>) {
  const { form } = useDraft()
  const question = form.questions[0]
  return question !== undefined && isChoice(question) ? <ChoiceEditor question={question} index={0} showCodes={showCodes} onEditLogic={vi.fn()} /> : null
}

const reasonOf = (form: FormV2 | undefined): ChoiceQuestion | undefined => {
  const question = form?.questions[0]
  return question !== undefined && isChoice(question) ? question : undefined
}

describe('ChoiceEditor: the options', () => {
  it('adds an option under the one where Enter is pressed, and focuses it', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('textbox', { name: 'Option 1' }))
    await user.keyboard('{Enter}')
    expect(reasonOf(harness.probe.current?.form)?.options.map((o) => o.code)).toStrictEqual(['price', 'option', 'slow'])
    expect(screen.getByRole('textbox', { name: 'Option 2' })).toHaveFocus()
  })

  it('deletes an empty option on Backspace and focuses the one above', async () => {
    const user = userEvent.setup()
    const question = choice('single_select', ['price', 'slow'])
    const harness = renderWithDraft(<LiveChoice />, formWith({ ...question, options: [...question.options, { code: 'empty', label: {} }] }))
    await user.click(screen.getByRole('textbox', { name: 'Option 3' }))
    await user.keyboard('{Backspace}')
    expect(reasonOf(harness.probe.current?.form)?.options.map((o) => o.code)).toStrictEqual(['price', 'slow'])
    expect(screen.getByRole('textbox', { name: 'Option 2' })).toHaveFocus()
  })

  it('pastes a list: one option per line, repeats skipped, blank lines ignored', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])))
    await user.click(screen.getByRole('button', { name: 'Paste list' }))
    await user.click(screen.getByRole('textbox', { name: /One option per line/ }))
    await user.paste("Low\nMedium\nlow\n\nIt's too expensive\nHigh")
    expect(screen.getByText('3 options · 2 duplicates skipped · 1 blank line ignored')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add 3 options' }))
    expect(reasonOf(harness.probe.current?.form)?.options.map((o) => o.code)).toStrictEqual(['price', 'low', 'medium', 'high'])
  })

  it("makes a new option's code from its label, and leaves a template option's code alone", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])))
    await user.click(screen.getByRole('button', { name: 'Add option' }))
    await user.type(screen.getByRole('textbox', { name: 'Option 2' }), 'Żółć łąka')
    await user.type(screen.getByRole('textbox', { name: 'Option 1' }), ' now')
    expect(reasonOf(harness.probe.current?.form)?.options.map((o) => o.code)).toStrictEqual(['price', 'zolc_laka'])
  })

  it('refuses a reserved code typed by hand', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveChoice showCodes />, formWith(choice('single_select', ['price', 'slow'])))
    const code = screen.getByRole('textbox', { name: 'Code of option 2' })
    await user.clear(code)
    await user.type(code, 'other')
    expect(screen.getByRole('alert')).toHaveTextContent('This code is reserved for the Other and None rows.')
  })

  it('shows codes read-only once the form has responses', () => {
    renderWithDraft(<LiveChoice showCodes />, formWith(choice('single_select', ['price'])), { meta: { has_responses: true, response_count: 3 } })
    expect(screen.queryByRole('textbox', { name: 'Code of option 1' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Code of option 1')).toHaveTextContent('price')
  })
})

describe('ChoiceEditor: the choice settings', () => {
  it('turns on Other, and offers None only on a multiple choice', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])))
    await user.click(screen.getByRole('switch', { name: '“Other” with a text box' }))
    expect(reasonOf(harness.probe.current?.form)?.other.enabled).toBe(true)
    expect(screen.queryByRole('switch', { name: /None of these/ })).not.toBeInTheDocument()
  })

  it('turns on None on a multiple choice', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price'])))
    await user.click(screen.getByRole('switch', { name: /None of these/ }))
    expect(reasonOf(harness.probe.current?.form)?.none.enabled).toBe(true)
  })

  it('says what Auto shows: a list up to 6 rows, a dropdown from 7 (Other counts)', () => {
    const codes = ['a', 'b', 'c', 'd', 'e', 'f']
    renderWithDraft(<LiveChoice />, formWith(choice('single_select', codes)))
    expect(screen.getByText('Auto shows a list here: 6 choices.')).toBeInTheDocument()
  })

  it('says Auto shows a dropdown at 7 rows', () => {
    const codes = ['a', 'b', 'c', 'd', 'e', 'f']
    renderWithDraft(<LiveChoice />, formWith(choice('single_select', codes, { other: { enabled: true } })))
    expect(screen.getByText('Auto shows a dropdown here: 7 choices.')).toBeInTheDocument()
  })

  it('flags At least over At most', () => {
    renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['a', 'b', 'c'], { min: 3, max: 2 })))
    expect(screen.getByText("At least can't be more than At most.")).toBeInTheDocument()
  })
})

describe('ChoiceEditor: routing', () => {
  it("writes an option's Go to as an `equals` rule on a single choice", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('button', { name: 'Routing' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Go to after “It\'s too expensive”' }), 'Ending: Thank you!')
    expect(reasonOf(harness.probe.current?.form)?.logic).toStrictEqual([{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'end_thanks' } }])
  })

  it("writes an option's Go to as `includes_any` on a multiple choice", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price', 'slow'])))
    await user.click(screen.getByRole('button', { name: 'Routing' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Go to after “It\'s too expensive”' }), 'Ending: Thank you!')
    expect(reasonOf(harness.probe.current?.form)?.logic).toStrictEqual([{ when: { op: 'includes_any', value: ['price'] }, then: { jump_to: 'end_thanks' } }])
  })

  it("stores an option's category by name, and shows the jump in the Labels view", async () => {
    const user = userEvent.setup()
    const question = choice('single_select', ['price'], { logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'q_next' } }] })
    const harness = renderWithDraft(<LiveChoice />, formWith(question))
    expect(within(screen.getByRole('list', { name: 'Options' })).getByLabelText('Goes to 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Routing' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category for “It\'s too expensive”' }), 'Pricing › Discounts')
    expect(reasonOf(harness.probe.current?.form)?.options[0]?.category).toStrictEqual({ category: 'pricing', subcategory: 'discounts' })
  })
})
