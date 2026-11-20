/** "Ask why when the score is low" on the score editors (7.63.00, model/askWhy.ts). */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import LiveQuestionEditor from '../test/LiveQuestionEditor'
import type { Question } from '../model/formsV2'

vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

const after: Question = { id: 'q_after', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: true, input_type: 'text' }
const tooling: Question = { id: 'q_tooling', type: 'rating', headline: { en: 'How were the tools?' }, required: true, scale: 'number', range: 5 }

describe('Ask why when the score is low', () => {
  it('adds an optional follow-up recalling the score, which a score above 2 jumps past', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LiveQuestionEditor id="q_tooling" />, sampleForm({ questions: [tooling, after] }))
    expect(screen.getByText('Adds an optional question after this one for scores of 2 or less, showing the score. You can edit it.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ask why when the score is low' }))
    const form = harness.probe.current?.form
    expect(form?.questions.map((q) => q.id)).toStrictEqual(['q_tooling', 'q_tooling_why', 'q_after'])
    expect([form?.questions[0]?.logic, form?.questions[1]?.headline]).toStrictEqual([
      [{ when: { op: 'gt', value: 2 }, then: { jump_to: 'q_after' } }], { en: "What's the main reason for your score of {{q_tooling}}?" },
    ])
    // Its rules now decide, so it is not offered again.
    expect(screen.queryByRole('button', { name: 'Ask why when the score is low' })).not.toBeInTheDocument()
  })

  it('takes NPS 6 or less as low', () => {
    renderWithDraft(<LiveQuestionEditor id="q_nps" />, sampleForm({
      questions: [{ id: 'q_nps', type: 'nps', headline: { en: 'Recommend us?' }, required: true }, after],
    }))
    expect(screen.getByText(/for scores of 6 or less/)).toBeInTheDocument()
  })

  it('is not offered on a score whose own rules would decide first', () => {
    renderWithDraft(<LiveQuestionEditor id="q_tooling" />, sampleForm({
      questions: [{ ...tooling, logic: [{ when: { op: 'lte', value: 1 }, then: { jump_to: 'end_thanks' } }] }, after],
    }))
    expect(screen.queryByRole('button', { name: 'Ask why when the score is low' })).not.toBeInTheDocument()
  })
})
