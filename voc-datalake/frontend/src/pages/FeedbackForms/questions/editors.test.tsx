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

  const sevenPoints: Question = { id: 'q_rating', type: 'rating', headline: { en: 'How was it?' }, required: true, scale: 'number', range: 7 }
  const disabled = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-disabled') === 'true'

  it("keeps an answered rating's points, saying why", () => {
    renderWithDraft(<LiveEditor id="q_rating" />, sampleForm({ questions: [sevenPoints] }), { meta: { has_responses: true } })
    expect(['3', '4', '5', '7', '10'].map(disabled)).toStrictEqual([true, true, true, false, true])
    expect(screen.getAllByText("Answers are stored on these points, so they can't change once the form has responses.").map((node) => node.tagName))
      .toContain('P')
  })

  it('offers no Faces to an answered rating of more than 5 points (Faces take 3 to 5), the other scales still', () => {
    renderWithDraft(<LiveEditor id="q_rating" />, sampleForm({ questions: [sevenPoints] }), { meta: { has_responses: true } })
    expect(['Faces', 'Stars', 'Numbers'].map(disabled)).toStrictEqual([true, false, false])
  })

  it("never gives the NPS helper's follow-ups a removed question's id", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_nps" />, sampleForm({
      questions: [{ id: 'q_nps', type: 'nps', headline: { en: 'Would you recommend us?' }, required: true }, after],
    }), { meta: { retired_ids: ['q_detractor_reason'] } })
    await user.click(screen.getByRole('button', { name: 'Ask detractors and promoters different questions' }))
    expect(harness.probe.current?.form.questions.map((q) => q.id)).toStrictEqual(['q_nps', 'q_detractor_reason_2', 'q_promoter_value', 'q_after'])
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

  it('says a missing translation in one line under the Question field, and Translate opens that language', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_feedback" />, sampleForm({ languages: ['en', 'pl'] }))
    expect(screen.getByText('Polski: 1 text missing')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Translate into Polski' }))
    expect(harness.go).toHaveBeenCalledWith('languages', ['pl'])
  })

  it('keeps Logic and Advanced as compact sections under the editor’s heading', () => {
    renderWithDraft(<LiveEditor id="q_feedback" />)
    expect(screen.getByRole('heading', { name: 'Advanced' })).toHaveClass('text-sm')
    expect(screen.getByRole('heading', { name: /^Logic/ })).toHaveClass('text-sm')
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

describe('the consent editor', () => {
  const consent: Question = { id: 'q_consent', type: 'consent', headline: { en: 'May we contact you?' }, required: false, label: {} }

  it('asks for the checkbox text until it is written', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_consent" />, sampleForm({ questions: [consent] }))
    expect(screen.getByText('Write the checkbox text.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Checkbox text' }), 'Yes, contact me')
    expect(harness.probe.current?.form.questions[0]).toHaveProperty('label', { en: 'Yes, contact me' })
    expect(screen.queryByText('Write the checkbox text.')).not.toBeInTheDocument()
  })

  it('names Required "Must be ticked to continue"', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_consent" />, sampleForm({ questions: [consent] }))
    await user.click(screen.getByRole('switch', { name: 'Must be ticked to continue' }))
    expect(harness.probe.current?.form.questions[0]?.required).toBe(true)
  })
})

describe('the statement editor', () => {
  const statement: Question = { id: 'q_note', type: 'statement', headline: { en: 'Thanks for your time.' }, required: false }

  it('names its text "Text" and has no Required', () => {
    renderWithDraft(<LiveEditor id="q_note" />, sampleForm({ questions: [statement] }))
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveValue('Thanks for your time.')
    expect(screen.queryByRole('switch', { name: 'Required' })).not.toBeInTheDocument()
  })

  it('adds a link button with its label', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_note" />, sampleForm({ questions: [statement] }))
    await user.click(screen.getByRole('switch', { name: /^Add a link button/ }))
    expect(harness.probe.current?.form.questions[0]).toHaveProperty('cta', { label: {}, url: '' })
    await user.type(screen.getByRole('textbox', { name: 'Button label' }), 'Learn more')
    expect(harness.probe.current?.form.questions[0]).toHaveProperty('cta.label', { en: 'Learn more' })
  })

  it("refuses the link's address until it is https", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_note" />, sampleForm({ questions: [{ ...statement, cta: { label: { en: 'Read' }, url: '' } }] }))
    await user.type(screen.getByRole('textbox', { name: 'Address' }), 'http://example.com/terms')
    expect(screen.getByText('The address must start with https://', { selector: 'li span' })).toBeInTheDocument()
    expect(harness.probe.current?.form.questions[0]).toHaveProperty('cta.url', 'http://example.com/terms')
  })

  it('drops the link button when it is switched off', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_note" />, sampleForm({ questions: [{ ...statement, cta: { label: { en: 'Read' }, url: 'https://example.com' } }] }))
    await user.click(screen.getByRole('switch', { name: /^Add a link button/ }))
    expect(harness.probe.current?.form.questions[0]).toHaveProperty('cta', undefined)
  })
})

describe('the text editor', () => {
  it('turns a long text short, and only then offers an answer type', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_feedback" />)
    expect(screen.queryByRole('combobox', { name: 'Answer type' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Short' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Answer type' }), 'Email')
    expect(harness.probe.current?.form.questions[0]).toMatchObject({ long: false, input_type: 'email' })
  })

  it('writes the placeholder and a limit, a blank limit being none', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveEditor id="q_feedback" />)
    await user.type(screen.getByRole('textbox', { name: 'Placeholder' }), 'Your words')
    const limit = screen.getByRole('spinbutton', { name: 'Limit (characters)' })
    await user.type(limit, '200')
    expect(harness.probe.current?.form.questions[0]).toMatchObject({ placeholder: { en: 'Your words' }, max_chars: 200 })
    await user.clear(limit)
    expect(harness.probe.current?.form.questions[0]).toHaveProperty('max_chars', undefined)
  })

  it('flags a limit over 5,000 characters', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LiveEditor id="q_feedback" />)
    await user.type(screen.getByRole('spinbutton', { name: 'Limit (characters)' }), '9000')
    expect(screen.getByText('The limit is 1 to 5,000 characters.')).toBeInTheDocument()
  })
})
