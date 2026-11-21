/** The Report's AI summary card (7.63.00): nothing to summarize, a summary withheld from this reader, one made for
 * another view (named, never shown), and each refusal in words. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const summarizeReport = vi.fn<(...args: unknown[]) => Promise<string>>()
const getResponses = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...actual, feedbackFormsV2Api: { ...actual.feedbackFormsV2Api,
    getResponses: (...args: unknown[]) => getResponses(...args), summarizeReport: (...args: unknown[]) => summarizeReport(...args) } }
})

import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { parseResponsesPage } from '../../../api/feedbackFormsV2Results'
import { renderWithDraft } from '../test/draftHarness'
import { REPORT, REPORT_FORM, VIEW } from './report-fixtures'
import AiSummaryCard from './AiSummaryCard'

const FILTERS = VIEW
const refusal = (status: number, code: string) => new FormsApiError(status, 'no', code, { errors: [], retryAfterSeconds: null, current: null })

describe('the AI summary card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getResponses.mockResolvedValue(parseResponsesPage({ responses: [{ response_id: 'fb_3', answers: { q_takeaway: 'Loved the labs' } }], next_cursor: null }))
  })

  it('offers nothing to summarize without open answers', () => {
    renderWithDraft(<AiSummaryCard form={REPORT_FORM} formId="f_test" filters={FILTERS} report={{ ...REPORT, ai: null, themes: [] }} />, REPORT_FORM)
    expect(screen.getByText('There are no open answers to summarize.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Summarize with AI' })).toBeDisabled()
  })

  it('says a summary that read responses this reader cannot see is not shown', () => {
    const withheld = { ...REPORT, ai: REPORT.ai === null ? null : { ...REPORT.ai, withheld: 'access' as const } }
    renderWithDraft(<AiSummaryCard form={REPORT_FORM} formId="f_test" filters={FILTERS} report={withheld} />, REPORT_FORM)
    expect(screen.getByText(/This summary read responses you can't see/)).toBeInTheDocument()
    expect(screen.queryByText('Keep the labs, shorten the intro.')).not.toBeInTheDocument()
  })

  it('shows the summary on the view it was made for', () => {
    renderWithDraft(<AiSummaryCard form={REPORT_FORM} formId="f_test" filters={FILTERS} report={REPORT} />, REPORT_FORM)
    expect(screen.getByText('Keep the labs, shorten the intro.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Summarize again' })).toBeEnabled()
  })

  const forB = { ...REPORT, ai: REPORT.ai === null ? null : { ...REPORT.ai, filters: { days: '30', 'hidden.customer': 'Example Ltd' } } }
  const viewOfB = { ...FILTERS, hidden: { customer: 'Sample Co' } }

  it('names the view a summary was made for on any other, with no summary, quote or staleness', () => {
    renderWithDraft(<AiSummaryCard form={REPORT_FORM} formId="f_test" filters={viewOfB} report={forB} />, REPORT_FORM)
    expect(screen.getByText('Made for another view: Last 30 days · Customer: Example Ltd')).toBeInTheDocument()
    expect(screen.queryByText('Keep the labs, shorten the intro.')).not.toBeInTheDocument()
    expect(screen.queryByText('Loved the labs', { exact: false })).not.toBeInTheDocument()
    // (its staleness is its own view's)
    expect(screen.queryByText('Newer responses since')).not.toBeInTheDocument()
  })

  it('summarizes this view from one made for another', async () => {
    const user = userEvent.setup()
    summarizeReport.mockResolvedValue('rpt_2')
    renderWithDraft(<AiSummaryCard form={REPORT_FORM} formId="f_test" filters={viewOfB} report={forB} />, REPORT_FORM)
    await user.click(screen.getByRole('button', { name: 'Summarize this view' }))
    await vi.waitFor(() => expect(summarizeReport).toHaveBeenCalledTimes(1))
    const [, request] = summarizeReport.mock.calls[0] ?? []
    expect(JSON.stringify(request)).toContain('"hidden.customer":"Sample Co"')
  })

  it.each([
    [refusal(429, 'rate_limited'), "That's 20 AI summaries this hour. Try again later."],
    [refusal(503, 'no_model'), 'No AI model is available in this deployment.'],
    [refusal(422, 'no_summary'), 'The AI found no themes in these answers.'],
    [new Error('down'), "The AI summary couldn't be made. Try again."],
  ])('words a refusal: %s', async (error, words) => {
    const user = userEvent.setup()
    summarizeReport.mockRejectedValue(error)
    renderWithDraft(<AiSummaryCard form={REPORT_FORM} formId="f_test" filters={FILTERS} report={{ ...REPORT, ai: null }} />, REPORT_FORM)
    await user.click(screen.getByRole('button', { name: 'Summarize with AI' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(words)
  })
})
