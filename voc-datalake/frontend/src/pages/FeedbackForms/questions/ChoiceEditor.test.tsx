import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
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

const codesOf = (form: FormV2 | undefined): string[] | undefined => reasonOf(form)?.options.map((o) => o.code)

/** The option rows of the Labels view. */
const optionRows = (): HTMLElement[] => within(screen.getByRole('list', { name: 'Options' })).getAllByRole('listitem')

/** The option row at `at` (0-based). */
function optionRow(at: number): HTMLElement {
  const row = optionRows()[at]
  if (row === undefined) throw new Error(`there is no option row ${String(at)}`)
  return row
}

/** A row's drag grip (hidden from the accessibility tree: the keyboard and the ⋯ menu are the other ways to move). */
function gripOf(row: HTMLElement): Element {
  const grip = row.querySelector('[draggable="true"]')
  if (grip === null) throw new Error('the row has no grip')
  return grip
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
  it("names an ending an option goes to by its title, a recall placeholder as [id] (F7, 7.71.04)", async () => {
    const user = userEvent.setup()
    const question = choice('single_select', ['price'], { logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'end_thanks' } }] })
    renderWithDraft(<LiveChoice />, { ...formWith(question), endings: [{ id: 'end_thanks', title: { en: 'Thanks for {{ event | coming }}!' } }], hidden_fields: [{ id: 'event' }] })
    expect(within(screen.getByRole('list', { name: 'Options' })).getByLabelText('Goes to Thanks for [event]!')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Routing' }))
    expect(screen.getAllByRole('option', { name: 'Ending: Thanks for [event]!' }).length).toBeGreaterThan(0)
  })

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

describe('ChoiceEditor: moving, duplicating and deleting an option', () => {
  it('moves an option down from its menu, Move up being off on the first', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow', 'rude'])))
    await user.click(screen.getByRole('button', { name: 'More actions for option 1' }))
    expect(screen.getByRole('menuitem', { name: /^Move up/ })).toHaveTextContent("It's already first.")
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['slow', 'price', 'rude'])
  })

  it('moves the last option up from its menu', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('button', { name: 'More actions for option 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['slow', 'price'])
  })

  it('moves the focused option with Alt+Shift+ArrowUp, and keeps it focused', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('textbox', { name: 'Option 2' }))
    await user.keyboard('{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}')
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['slow', 'price'])
    expect(screen.getByRole('textbox', { name: 'Option 1' })).toHaveFocus()
  })

  it('moves an option dropped on another row', () => {
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow', 'rude'])))
    fireEvent.dragStart(gripOf(optionRow(0)))
    fireEvent.dragOver(optionRow(2))
    fireEvent.drop(optionRow(2))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['slow', 'rude', 'price'])
  })

  it('leaves the options in place when a row is dropped on itself', () => {
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    fireEvent.dragStart(gripOf(optionRow(1)))
    fireEvent.drop(optionRow(1))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price', 'slow'])
  })

  it('duplicates an option right after it, with a code of its own', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('button', { name: 'More actions for option 1' }))
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price', 'it_s_too_expensive', 'slow'])
    expect(screen.getByRole('textbox', { name: 'Option 2' })).toHaveValue("It's too expensive")
  })

  it('deletes an option from its menu, but never the last one', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('button', { name: 'More actions for option 2' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price'])
    await user.click(screen.getByRole('button', { name: 'More actions for option 1' }))
    expect(screen.getByRole('menuitem', { name: /^Delete…/ })).toHaveTextContent('A choice needs at least one option.')
  })
})

describe("ChoiceEditor: an option's code", () => {
  it('applies a code typed by hand when the field is left, and the label no longer changes it', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice showCodes />, formWith(choice('single_select', ['price'])))
    await user.click(screen.getByRole('button', { name: 'Add option' }))
    await user.type(screen.getByRole('textbox', { name: 'Option 2' }), 'Fast')
    const code = screen.getByRole('textbox', { name: 'Code of option 2' })
    await user.clear(code)
    await user.type(code, 'quick')
    await user.tab()
    await user.type(screen.getByRole('textbox', { name: 'Option 2' }), ' delivery')
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price', 'quick'])
  })

  it("refuses another option's code, and keeps its own when the field is left", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice showCodes />, formWith(choice('single_select', ['price', 'slow'])))
    const code = screen.getByRole('textbox', { name: 'Code of option 1' })
    await user.clear(code)
    await user.type(code, 'slow')
    expect(screen.getByRole('alert')).toHaveTextContent('Two options have the code slow.')
    await user.tab()
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price', 'slow'])
  })

  it('refuses a code that is not lower-case letters, digits and _', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveChoice showCodes />, formWith(choice('single_select', ['price'])))
    await user.type(screen.getByRole('textbox', { name: 'Code of option 1' }), ' Now')
    expect(screen.getByRole('alert')).toHaveTextContent('A code uses lower-case letters, digits and _, up to 40 characters.')
  })
})

describe('ChoiceEditor: lines pasted into an option', () => {
  /** Paste `lines` into the empty second option of a two-option question. */
  const pasteIntoEmpty = async (user: ReturnType<typeof userEvent.setup>, lines: string) => {
    const question = choice('single_select', ['price'])
    const harness = renderWithDraft(<LiveChoice />, formWith({ ...question, options: [...question.options, { code: 'empty', label: {} }] }))
    await user.click(screen.getByRole('textbox', { name: 'Option 2' }))
    await user.paste(lines)
    return harness
  }

  it('offers to make the lines options after the one pasted into', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await user.click(screen.getByRole('textbox', { name: 'Option 1' }))
    await user.paste('Rude staff\n\nLong wait')
    expect(screen.getByText('Paste 2 lines as 2 options?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add as options' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price', 'rude_staff', 'long_wait', 'slow'])
  })

  it('puts the lines in place of the empty option pasted into', async () => {
    const user = userEvent.setup()
    const harness = await pasteIntoEmpty(user, 'Rude staff\nLong wait')
    await user.click(screen.getByRole('button', { name: 'Add as options' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price', 'rude_staff', 'long_wait'])
  })

  it('keeps the lines as one label when asked', async () => {
    const user = userEvent.setup()
    const harness = await pasteIntoEmpty(user, 'Rude staff\nLong wait')
    await user.click(screen.getByRole('button', { name: 'Keep as one' }))
    expect(reasonOf(harness.probe.current?.form)?.options[1]?.label).toStrictEqual({ en: 'Rude staff Long wait' })
    expect(screen.queryByRole('button', { name: 'Add as options' })).not.toBeInTheDocument()
  })

  it('pastes one line as text, with nothing to ask', async () => {
    const user = userEvent.setup()
    const harness = await pasteIntoEmpty(user, 'Rude staff')
    expect(reasonOf(harness.probe.current?.form)?.options[1]?.label).toStrictEqual({ en: 'Rude staff' })
    expect(screen.queryByRole('button', { name: 'Add as options' })).not.toBeInTheDocument()
  })
})

describe('ChoiceEditor: Paste list', () => {
  const openPasted = async (user: ReturnType<typeof userEvent.setup>, lines: string) => {
    await user.click(screen.getByRole('button', { name: 'Paste list' }))
    await user.click(screen.getByRole('textbox', { name: /One option per line/ }))
    await user.paste(lines)
  }

  it('replaces every option with the list, and closes', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price', 'slow'])))
    await openPasted(user, "Low\nIt's too expensive")
    await user.click(screen.getByRole('button', { name: 'Replace all…' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['low', 'it_s_too_expensive'])
    expect(screen.queryByRole('textbox', { name: /One option per line/ })).not.toBeInTheDocument()
  })

  /** Replace all… on a form with responses, with two lines pasted. */
  const replaceAnswered = async (user: ReturnType<typeof userEvent.setup>) => {
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])), { meta: { has_responses: true, response_count: 3 } })
    await openPasted(user, 'Low\nHigh')
    await user.click(screen.getByRole('button', { name: 'Replace all…' }))
    return harness
  }

  it('asks before replacing the options of a form with responses', async () => {
    const user = userEvent.setup()
    const harness = await replaceAnswered(user)
    expect(screen.getByRole('dialog')).toHaveTextContent('This form has responses: answers given to the options you replace stay in Results as removed options.')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replace all' }))
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['low', 'high'])
  })

  it('keeps the options when the replace is not confirmed', async () => {
    const user = userEvent.setup()
    const harness = await replaceAnswered(user)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price'])
  })

  it('closes on Cancel without a change', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])))
    await openPasted(user, 'Low')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Paste list' })).toHaveAttribute('aria-expanded', 'false')
    expect(codesOf(harness.probe.current?.form)).toStrictEqual(['price'])
  })

  it('has nothing to add or replace until a line is there', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])))
    await user.click(screen.getByRole('button', { name: 'Paste list' }))
    expect(screen.getByRole('button', { name: 'Add 0 options' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Replace all…' })).toBeDisabled()
  })
})

describe('ChoiceEditor: the 50-option limit', () => {
  const fifty = Array.from({ length: 50 }, (_unused, n) => `o${String(n)}`)

  it('adds no option past 50, from the button or Enter', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', fifty)))
    expect(screen.getByText('50 of 50')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add option' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: 'Add option' }))
    await user.type(screen.getByRole('textbox', { name: 'Option 1' }), '{Enter}')
    expect(reasonOf(harness.probe.current?.form)?.options).toHaveLength(50)
  })

  it('duplicates no option past 50', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', fifty)))
    await user.click(screen.getByRole('button', { name: 'More actions for option 1' }))
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(reasonOf(harness.probe.current?.form)?.options).toHaveLength(50)
  })
})

describe('ChoiceEditor: Other, None, the order and Show as', () => {
  it("writes Other's label and placeholder", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'], { other: { enabled: true } })))
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Something else')
    await user.type(screen.getByRole('textbox', { name: 'Placeholder' }), 'Tell us')
    expect(reasonOf(harness.probe.current?.form)?.other).toStrictEqual({ enabled: true, label: { en: 'Something else' }, placeholder: { en: 'Tell us' } })
  })

  it("writes None's label", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price'], { none: { enabled: true } })))
    await user.type(screen.getByRole('textbox', { name: 'None label' }), 'Nothing')
    expect(reasonOf(harness.probe.current?.form)?.none).toStrictEqual({ enabled: true, label: { en: 'Nothing' } })
  })

  it('shuffles the options', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('single_select', ['price'])))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Order' }), 'Shuffle')
    expect(reasonOf(harness.probe.current?.form)?.shuffle).toBe('all')
  })

  it('shows a few choices as a dropdown, and says a dropdown hides them', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price', 'slow'])))
    await user.click(within(screen.getByRole('group', { name: 'Show as' })).getByRole('button', { name: 'Dropdown' }))
    expect(reasonOf(harness.probe.current?.form)?.display).toBe('dropdown')
    expect(screen.getByText('A list shows every choice at once; a dropdown hides them.')).toBeInTheDocument()
    expect(screen.queryByText(/^Auto shows/)).not.toBeInTheDocument()
  })
})

describe('ChoiceEditor: At least and At most', () => {
  it('writes both, and says what respondents see', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price', 'slow', 'rude'])))
    expect(screen.getByText(/^Blank At least is 1 when the question is required/)).toBeInTheDocument()
    await user.type(screen.getByRole('spinbutton', { name: 'At least' }), '1')
    await user.type(screen.getByRole('spinbutton', { name: 'At most' }), '2')
    expect(reasonOf(harness.probe.current?.form)).toMatchObject({ min: 1, max: 2 })
    expect(screen.getByText('Respondents see “Choose up to 2”.')).toBeInTheDocument()
  })

  it('flags At most over the choices there are', () => {
    renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price', 'slow'], { max: 5 })))
    expect(screen.getByRole('spinbutton', { name: 'At most' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText("At most can't be more than the 2 choices.")).toBeInTheDocument()
  })

  it('clears At least when it is blanked', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveChoice />, formWith(choice('multi_select', ['price', 'slow'], { min: 1 })))
    await user.clear(screen.getByRole('spinbutton', { name: 'At least' }))
    expect(reasonOf(harness.probe.current?.form)?.min).toBeUndefined()
  })
})
