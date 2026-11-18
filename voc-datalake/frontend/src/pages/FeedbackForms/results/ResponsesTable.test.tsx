/**
 * Results › Responses (UX §10.4): the rows under the filters, Load more, and one response in the side sheet with
 * every answer in form order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const getResponses = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  const { parseResponsesPage } = await import('../../../api/feedbackFormsV2Results')
  return {
    ...actual,
    feedbackFormsV2Api: {
      ...actual.feedbackFormsV2Api,
      getResponses: async (...args: unknown[]) => parseResponsesPage(await getResponses(...args)),
    },
  }
})

import { at } from '../../../test/defined'
import { renderWithDraft } from '../test/draftHarness'
import { RESULTS_FORM } from './results-fixtures'
import ResultsTab from './ResultsTab'

const response = (id: string, overrides: Record<string, unknown> = {}) => ({
  response_id: id, submitted_at: '2026-11-17T14:02:00Z', form_revision: 4, language: 'en',
  answers: {
    q_why: { codes: ['cant_find'], other: 'printing' },
    q_nps: 9,
    q_comment: 'The export is gone',
  },
  hidden: { user_id: 'u_1823' }, ending_id: 'end_thanks', is_test: false,
  ...overrides,
})

describe('Results responses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getResponses.mockResolvedValue({ responses: [response('r_1'), response('r_2', { is_test: true })], next_cursor: null })
  })

  it('lists each response with its answers summarised, its hidden values and Test on a test one', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses'] })
    const rows = await screen.findAllByRole('row')
    expect(rows[1]).toHaveTextContent("I can't find what I need, Something else: “printing” · 9 · “The export is gone”")
    expect(rows[1]).toHaveTextContent('user_id u_1823')
    expect(rows[2]).toHaveTextContent('Test')
  })

  it('opens a response by its path', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses'] })
    await user.click(at(await screen.findAllByRole('button', { name: /Open the response from/ }), 0))
    expect(harness.go).toHaveBeenCalledWith('results', ['responses', 'r_1'])
  })

  it('shows one response in the sheet, every answer in form order, and walks to the next', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses', 'r_1'] })
    const sheet = await screen.findByRole('dialog')
    const answers = within(within(sheet).getByRole('list', { name: 'Answers' })).getAllByRole('listitem')
    expect(answers.map((item) => item.textContent)).toStrictEqual([
      "1 · What made you switch back?I can't find what I need, Something else: “printing”",
      '2 · How likely are you to recommend us?9',
      "3 · How satisfied are you with this feature?Not answered: skipped, or not on this respondent's path.",
      "4 · How satisfied are you with the help?Not answered: skipped, or not on this respondent's path.",
      "5 · How easy was it?Not answered: skipped, or not on this respondent's path.",
      '6 · Anything else?The export is gone',
    ])
    expect(within(sheet).getByText('Answered on version 4')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Next' }))
    expect(harness.go).toHaveBeenCalledWith('results', ['responses', 'r_2'])
  })

  it('loads the next page with the cursor', async () => {
    const user = userEvent.setup()
    getResponses.mockResolvedValueOnce({ responses: [response('r_1')], next_cursor: 'c_2' }).mockResolvedValueOnce({ responses: [response('r_2')], next_cursor: null })
    renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses'] })
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(getResponses).toHaveBeenLastCalledWith('f_test', { days: 30, language: '', ending: '', hidden: {}, includeTest: false }, { limit: 50, cursor: 'c_2' })
  })
})
