/** Results › Summary's skip rates (7.63.00): on every card that was asked, a "Most skipped" order, and an "Ask why"
 * follow-up's answer rate. */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { parseFormResults } from '../../../api/feedbackFormsV2Results'
import { renderWithDraft } from '../test/draftHarness'
import { blankForm } from '../test/blankForm'
import type { FormV2 } from '../model/formsV2'
import ResultsSummary from './ResultsSummary'

vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

const FORM: FormV2 = {
  ...blankForm('en'),
  questions: [
    { id: 'q_tooling', type: 'rating', headline: { en: 'How were the tools?' }, required: false, scale: 'number', range: 5,
      logic: [{ when: { op: 'gt', value: 2 }, then: { jump_to: 'q_takeaway' } }] },
    { id: 'q_tooling_why', type: 'open_text', headline: { en: 'Why {{q_tooling}}?' }, required: false, long: true, input_type: 'text' },
    { id: 'q_takeaway', type: 'open_text', headline: { en: 'Your takeaway?' }, required: false, long: true, input_type: 'text' },
  ],
}
const RESULTS = parseFormResults({
  total: 10, test_count: 0, last_response_at: '2026-11-17T12:00:00Z', endings: {}, removed_questions: [], removed_options: {}, funnel: null,
  questions: {
    q_tooling: { answered: 9, skipped: 1, not_shown: 0, distribution: { 1: 2, 4: 7 } },
    q_tooling_why: { answered: 1, skipped: 1, not_shown: 8, follow_up_of: 'q_tooling', latest: [] },
    q_takeaway: { answered: 2, skipped: 8, not_shown: 0, latest: [] },
  },
})

const headings = () => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

describe('skip rates on the summary', () => {
  it('says each card’s skip rate and a follow-up’s answer rate of those asked', () => {
    renderWithDraft(<ResultsSummary form={FORM} results={RESULTS} onShowAll={vi.fn()} />, FORM)
    expect(within(screen.getByRole('region', { name: '1 · How were the tools?' })).getByText('Skip rate 10%')).toBeInTheDocument()
    const why = screen.getByRole('region', { name: '2 · Why [q_tooling]?' })
    expect(within(why).getByText('Follow-up to question 1')).toBeInTheDocument()
    expect(within(why).getByText('Answered by 50% of those asked')).toBeInTheDocument()
  })

  it('puts the most skipped first when asked, keeping each question’s number', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ResultsSummary form={FORM} results={RESULTS} onShowAll={vi.fn()} />, FORM)
    expect(headings().slice(0, 3)).toStrictEqual(['1 · How were the tools?', '2 · Why [q_tooling]?', '3 · Your takeaway?'])
    await user.click(screen.getByRole('button', { name: 'Most skipped' }))
    expect(headings().slice(0, 3)).toStrictEqual(['3 · Your takeaway?', '2 · Why [q_tooling]?', '1 · How were the tools?'])
  })
})
