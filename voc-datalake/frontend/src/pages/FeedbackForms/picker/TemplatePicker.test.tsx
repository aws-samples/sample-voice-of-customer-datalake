import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { z } from 'zod'
import { renderPicker } from '../test/pickerHarness'

vi.mock('../preview/PreviewFrame', () => import('../test/previewFrameStub'))

const handoffShape = z.object({
  templateId: z.string().nullable(),
  ai: z.unknown(),
  form: z.object({ name: z.string(), language: z.string(), enabled: z.boolean(), questions: z.array(z.object({ id: z.string() })) }),
})

/** The new form the stand-in builder was handed. */
async function handedForm() {
  const output = await screen.findByTestId('handoff')
  return handoffShape.parse(JSON.parse(output.textContent))
}

const railButton = (name: RegExp) => within(screen.getByRole('group', { name: 'Goals' })).getByRole('button', { name })

describe('TemplatePicker', () => {
  it('starts with "Describe your form", then the thirteen templates under All, with each goal and its count', () => {
    renderPicker()
    expect(screen.getByRole('textbox', { name: 'Describe your form' })).toBeInTheDocument()
    expect(screen.getAllByTestId(/^template-/)).toHaveLength(13)
    expect(railButton(/^All\s*13$/)).toHaveAttribute('aria-pressed', 'true')
    expect([railButton(/^Loyalty\s*3$/), railButton(/^Drop-offs\s*3$/), railButton(/^Product\s*4$/), railButton(/^Onboarding\s*1$/),
      railButton(/^Events\s*1$/)]).toHaveLength(5)
  })

  it('shows only the templates of the goal picked', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(railButton(/^Drop-offs/))
    expect(screen.getAllByTestId(/^template-/).map((card) => card.dataset['testid'])).toStrictEqual(['template-churn', 'template-old_ui', 'template-abandonment'])
  })

  it('says what a card holds: its question types, where it runs and how long it takes', () => {
    renderPicker()
    const card = screen.getByTestId('template-churn')
    expect(card).toHaveTextContent('Cancellation / churn')
    expect(card).toHaveTextContent(/Single choice\s*×2/)
    expect(card).toHaveTextContent('In-app · Link')
    expect(card).toHaveTextContent('~1 min')
  })

  it('clamps a card\'s purpose to two lines, and shows at most three types in one row, then how many more', () => {
    renderPicker()
    const card = screen.getByTestId('template-churn')
    const purpose = screen.getByText('Find out why customers cancel, with the right follow-up for each reason.')
    // (`block` beside `line-clamp-2` won, so the purpose ran to four lines)
    expect(purpose).toHaveClass('line-clamp-2')
    expect(purpose).not.toHaveClass('block')
    // Five types: three chips and "+2 more" on a wide card; on one under 28rem, two chips and "+3 more".
    expect(within(card).getByText('+2 more')).toHaveClass('hidden', '@md:inline-flex')
    expect(within(card).getByText('+3 more')).toHaveClass('@md:hidden')
  })

  it('lays the cards out in one column below 2xl and two at 2xl, every column of the page able to shrink', () => {
    renderPicker()
    const grid = screen.getByTestId('template-churn').parentElement
    expect(grid).toHaveClass('grid-cols-1', '2xl:grid-cols-2')
    const preview = screen.getByRole('complementary', { name: 'Preview' })
    expect(preview).toHaveClass('min-w-0')
    expect(preview.parentElement).toHaveClass('grid-cols-1')
  })

  it('asks to pick something before it previews anything', () => {
    renderPicker()
    expect(screen.getByText('Pick a template, or describe your form, to see it here.')).toBeInTheDocument()
  })

  it('previews the card picked, with its questions numbered and its logic as sentences', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByTestId('template-old_ui'))
    const preview = screen.getByRole('complementary', { name: 'Preview' })
    expect(screen.getByTestId('template-old_ui')).toHaveAttribute('aria-pressed', 'true')
    expect(within(preview).getByRole('heading', { name: 'Switching back to the old interface' })).toBeInTheDocument()
    expect(within(preview).getByText('If the answer includes any of “A function I use is missing” → 2 · Which function is missing?')).toBeInTheDocument()
    expect(within(preview).getByText('Otherwise → 3 · Which task are you working on right now?')).toBeInTheDocument()
  })

  it('opens the builder with the template as an unsaved form, Off, in the "Create in" language', async () => {
    const user = userEvent.setup()
    renderPicker({ search: '?template=old_ui' })
    await user.click(screen.getByRole('button', { name: 'Use this template' }))
    const handed = await handedForm()
    expect([handed.templateId, handed.form.name, handed.form.enabled, handed.form.language]).toStrictEqual(['old_ui', 'Switching back to the old interface', false, 'en'])
    expect(handed.form.questions.map((question) => question.id)).toStrictEqual(['q_why', 'q_missing_function', 'q_task', 'q_return', 'q_comment'])
  })

  it('makes the form in the language chosen in "Create in"', async () => {
    const user = userEvent.setup()
    renderPicker({ search: '?template=blank' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Create in' }), 'pl')
    await user.click(screen.getByRole('button', { name: 'Use this template' }))
    expect((await handedForm()).form.language).toBe('pl')
  })
})

describe('TemplatePicker: Describe your form', () => {
  it('fills an empty description from a Try example, and the pilot\'s example also sets Polski and In-app', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: 'Users who switch back to the old UI…' }))
    expect(screen.getByRole('textbox', { name: 'Describe your form' })).toHaveValue('Ask app users who switch back to the old UI why, with predefined reasons.')
    expect(screen.getByRole('combobox', { name: 'Create in' })).toHaveValue('pl')
    expect(screen.getByText('in Polski', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'In-app' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('has one language control, "Create in": Describe says the language and moves there to change it', async () => {
    const user = userEvent.setup()
    renderPicker()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.getByText('in English', { exact: false })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'change' }))
    expect(screen.getByRole('combobox', { name: 'Create in' })).toHaveFocus()
  })

  it('asks before an example replaces the person\'s own description, and keeps it when they say so', async () => {
    const user = userEvent.setup()
    renderPicker()
    const description = screen.getByRole('textbox', { name: 'Describe your form' })
    await user.type(description, 'My own words about the form')
    await user.click(screen.getByRole('button', { name: 'A short NPS for our mobile app…' }))
    expect(screen.getByText('Replace your description?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep mine' }))
    expect(description).toHaveValue('My own words about the form')
  })

  it('asks for a description before drafting', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: 'Draft it' }))
    expect(screen.getByText('Describe your form first.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Describe your form' })).toHaveFocus()
  })

  it('keeps the description the builder\'s Discard draft brought back', () => {
    renderPicker({ state: { describe: 'Ask customers who cancel why' } })
    expect(screen.getByRole('textbox', { name: 'Describe your form' })).toHaveValue('Ask customers who cancel why')
  })
})
