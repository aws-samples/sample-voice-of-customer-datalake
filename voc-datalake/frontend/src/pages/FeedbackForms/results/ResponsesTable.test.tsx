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

  it('below md shows each response as a card: time · ending · language, then its first answers', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses'] })
    const cards = within(await screen.findByRole('list', { name: 'Responses, newest first' })).getAllByRole('listitem')
    expect(cards[0]).toHaveTextContent(/^Nov 17, \d{1,2}:02\s?[AP]M · Thank you · en/u)
    expect(cards[0]).toHaveTextContent("I can't find what I need, Something else: “printing” · 9 · “The export is gone”")
    expect(cards[1]).toHaveTextContent('Test')
  })

  it('keeps the 40rem table from md only, scrolling inside its card, and a card opens its response', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses'] })
    const list = await screen.findByRole('list', { name: 'Responses, newest first' })
    expect([list.className.includes('md:hidden'), screen.getByRole('table').parentElement?.className.split(' ')])
      .toStrictEqual([true, expect.arrayContaining(['hidden', 'md:block', 'overflow-x-auto', 'min-w-0'])])
    await user.click(within(at(within(list).getAllByRole('listitem'), 1)).getByRole('button', { name: /Open the response from/ }))
    expect(harness.go).toHaveBeenCalledWith('results', ['responses', 'r_2'])
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

  it('opens a response past the loaded pages (a Report quote\'s) by reading on until it is found', async () => {
    // (review round 1 of the second gate, 7.66.00: the theme's quote names a response on the third page)
    getResponses
      .mockResolvedValueOnce({ responses: [response('r_1')], next_cursor: 'c_2' })
      .mockResolvedValueOnce({ responses: [response('r_2')], next_cursor: 'c_3' })
      .mockResolvedValueOnce({ responses: [response('r_quoted', { answers: { q_comment: 'Quoted in the report' } })], next_cursor: 'c_4' })
    renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses', 'r_quoted'] })
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('Quoted in the report')).toBeInTheDocument()
    expect(getResponses).toHaveBeenCalledTimes(3)   // (found on the third page: no fourth read)
  })

  it('stops reading on for an open response once a page fails, and leaves Load more to retry it', async () => {
    // (7.71.00: a failing page 2 was asked for again without end)
    getResponses
      .mockResolvedValueOnce({ responses: [response('r_1')], next_cursor: 'c_2' })
      .mockRejectedValueOnce(new Error('throttled'))
    renderWithDraft(<ResultsTab />, RESULTS_FORM, { rest: ['responses', 'r_far'] })
    await waitFor(() => expect(getResponses).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(getResponses).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeEnabled()
  })
})
