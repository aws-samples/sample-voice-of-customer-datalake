import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { useDraft } from '../builder/formDraftContext'
import type { Question } from '../model/formsV2'
import QuestionEditor from './QuestionEditor'
import EndingEditor from './EndingEditor'
import { requestFocus } from './focusRequest'

vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

/** The editor of question `id`, read from the draft on every render (as the Questions tab gives it). */
function LiveEditor({ id }: Readonly<{ id: string }>) {
  const { form } = useDraft()
  const index = form.questions.findIndex((q) => q.id === id)
  const question = form.questions[index]
  return question === undefined ? null : <QuestionEditor question={question} index={index} />
}

function LiveEnding({ id }: Readonly<{ id: string }>) {
  const { form } = useDraft()
  const ending = form.endings.find((e) => e.id === id)
  return ending === undefined ? null : <EndingEditor ending={ending} />
}

const after: Question = { id: 'q_after', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: true, input_type: 'text' }

describe('the scale editors', () => {
  it('offers faces in 3 to 5 points only', () => {
    renderWithDraft(<LiveEditor id="q_rating" />, sampleForm({
      questions: [{ id: 'q_rating', type: 'rating', headline: { en: 'How was it?' }, required: true, scale: 'smiley', range: 5 }],
    }))
    expect(screen.getByRole('button', { name: '7' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '10' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '4' })).not.toHaveAttribute('aria-disabled')
  })

  it('asks detractors and promoters different questions with two rules, passives going on as before', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_nps" />, sampleForm({
      questions: [{ id: 'q_nps', type: 'nps', headline: { en: 'Would you recommend us?' }, required: true }, after],
    }))
    await user.click(screen.getByRole('button', { name: 'Ask detractors and promoters different questions' }))
    const form = harness.probe.current?.form
    expect(form?.questions.map((q) => q.id)).toStrictEqual(['q_nps', 'q_detractor_reason', 'q_promoter_value', 'q_after'])
    expect(form?.questions[0]?.logic?.map((rule) => [rule.when.op, rule.when.value, rule.then.jump_to])).toStrictEqual([
      ['lte', 6, 'q_detractor_reason'], ['gte', 9, 'q_promoter_value'], ['submitted', undefined, 'q_after'],
    ])
    expect(form?.questions[1]?.headline).toStrictEqual({ en: "What's the main reason for your score?" })
  })
})

describe('the question editor', () => {
  it('turns a single choice into a multiple choice, its `equals` rules into `includes_any`', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_reason" />, sampleForm({
      questions: [{
        id: 'q_reason', type: 'single_select', headline: { en: 'Why?' }, required: true,
        options: [{ code: 'price', label: { en: 'Too expensive' } }], other: { enabled: false }, none: { enabled: false },
        shuffle: 'none', display: 'auto', logic: [{ when: { op: 'equals', value: 'price' }, then: { jump_to: 'end_thanks' } }],
      }],
    }))
    await user.selectOptions(screen.getByRole('combobox', { name: /Question 1: type/ }), 'Multiple choice')
    expect(harness.probe.current?.form.questions[0]?.type).toBe('multi_select')
    expect(harness.probe.current?.form.questions[0]?.logic).toStrictEqual([{ when: { op: 'includes_any', value: ['price'] }, then: { jump_to: 'end_thanks' } }])
  })

  it('focuses the Question field of a question just added', () => {
    requestFocus('q_feedback')
    renderWithDraft(<LiveEditor id="q_feedback" />)
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveFocus()
  })

  it('needs a contact question to show at least one field', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveEditor id="q_contact" />, sampleForm({
      questions: [{
        id: 'q_contact', type: 'contact_info', headline: { en: 'Where can we reach you?' }, required: true,
        fields: { name: { show: true, required: false }, email: { show: true, required: true }, phone: { show: false, required: false }, company: { show: false, required: false } },
      }],
    }))
    expect(screen.queryByText('Show at least one field.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Show Name' }))
    await user.click(screen.getByRole('switch', { name: 'Show Email' }))
    expect(screen.getByText('Show at least one field.')).toBeInTheDocument()
  })
})

describe('the ending editor', () => {
  it("refuses a button's address until it is https", async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveEnding id="end_thanks" />)
    await user.click(screen.getByRole('switch', { name: 'Add a button' }))
    await user.type(screen.getByRole('textbox', { name: 'Button label' }), 'Help')
    const address = screen.getByRole('textbox', { name: 'Address' })
    await user.type(address, 'http://example.com/help')
    expect(screen.getByText('The address must start with https://', { selector: 'li span' })).toBeInTheDocument()
    await user.clear(address)
    await user.type(address, 'https://example.com/help')
    expect(screen.queryByText('The address must start with https://', { selector: 'li span' })).not.toBeInTheDocument()
  })

  it('says which paths end here', () => {
    renderWithDraft(<LiveEnding id="end_thanks" />)
    expect(screen.getByText('the end of the questions (default)')).toBeInTheDocument()
  })
})
