/**
 * Results › Report (7.63.00): the KPIs, the segments (each of at least 5, the smaller merged and withheld), a matrix's
 * heatmap, the themes with real quotes, the AI summary (labelled, stale, asked for with the open answers only), the
 * one-page PDF and Compare.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const getReport = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const compareForms = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const getResponses = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const summarizeReport = vi.fn<(...args: unknown[]) => Promise<string>>()
const getFeedbackForms = vi.fn<() => Promise<unknown>>()
const openPrintWindow = vi.fn<(options: { title: string }) => Window | null>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...actual, feedbackFormsV2Api: { ...actual.feedbackFormsV2Api,
    getReport: (...args: unknown[]) => getReport(...args), compareForms: (...args: unknown[]) => compareForms(...args),
    getResponses: (...args: unknown[]) => getResponses(...args), summarizeReport: (...args: unknown[]) => summarizeReport(...args) } }
})
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, api: { ...actual.api, getFeedbackForms: () => getFeedbackForms() } }
})
vi.mock('../../../utils/printUtils', () => ({ openPrintWindow: (options: { title: string }) => openPrintWindow(options) }))

import { parseFormComparison } from '../../../api/feedbackFormsReport'
import { parseResponsesPage } from '../../../api/feedbackFormsV2Results'
import { renderWithDraft } from '../test/draftHarness'
import { REPORT, REPORT_FORM, SEGMENTED } from './report-fixtures'
import ResultsTab from '../results/ResultsTab'

describe('the Report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getReport.mockImplementation((_id, _filters, groupBy) => Promise.resolve(groupBy === null ? REPORT : SEGMENTED))
    getFeedbackForms.mockResolvedValue({ success: true, forms: [
      { form_id: 'f_other', name: 'Other workshop', template: { id: 'workshop', version: 1 } }, { form_id: 'f_test', name: 'This one' },
    ] })
    compareForms.mockResolvedValue(parseFormComparison({ by: null, min_size: 5, questions: [{ id: 'q_nps', type: 'nps', headline: 'Recommend it?' }],
      forms: [{ form_id: 'f_test', name: 'Example Ltd workshop', matched: ['q_nps'] }, { form_id: 'f_other', name: 'Other workshop', unmatched: { q_nps: 'different' } }],
      points: [{ form_id: 'f_test', value: null, responses: 9, scores: { q_nps: { type: 'nps', answered: 9, nps: 33.3 } } },
        { form_id: 'f_other', value: null, responses: 3, scores: null }, { form_id: 'f_test', value: 'Sample Co', responses: 6, scores: null, withheld: 'complement' }] }))
    getResponses.mockResolvedValue(parseResponsesPage({ responses: [
      { response_id: 'fb_3', submitted_at: '2026-11-18', answers: { q_takeaway: 'Loved the labs', q_contact: { email: 'p@example.com' } } },
      { response_id: 'fb_4', submitted_at: '2026-11-17', answers: { q_contact: { email: 'q@example.com' } } },
    ], next_cursor: null }))
    summarizeReport.mockResolvedValue('rpt_2')
  })

  it('shows the KPIs, the heatmap, the themes with real quotes and the labelled AI summary', async () => {
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    expect(await screen.findByText('33')).toBeInTheDocument()
    const heatmap = screen.getByRole('region', { name: 'Each part' })
    expect(within(heatmap).getByRole('row', { name: /Labs/ })).toHaveTextContent('75% (6)')
    expect(screen.getByRole('button', { name: 'Open the response: Loved the labs' })).toBeInTheDocument()
  })

  it('labels the AI summary AI, and says when newer responses came in', async () => {
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    const ai = await screen.findByRole('region', { name: /AI summary/ })
    expect(within(ai).getByText('AI')).toBeInTheDocument()
    expect(within(ai).getByText('Newer responses since')).toBeInTheDocument()
    expect(within(ai).getByText('Keep the labs, shorten the intro.')).toBeInTheDocument()
  })

  it('groups by a segment, merging the small ones and withholding their scores', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    await user.selectOptions(await screen.findByLabelText('Segment by'), 'q_role')
    await waitFor(() => expect(getReport).toHaveBeenLastCalledWith('f_test', expect.anything(), 'q_role'))
    const table = await screen.findByRole('table', { name: 'Scores by segment' })
    expect(within(table).getByRole('row', { name: /^QA/ })).toHaveTextContent('43')
    expect(within(table).getByRole('row', { name: /Other \(1 segment of fewer than 5\)/ })).toHaveTextContent('Too few responses to show their scores')
    expect(within(table).getByRole('row', { name: /^Design/ })).toHaveTextContent("Hidden with the small group, so its scores can't be worked out")
  })

  it('asks the AI with the open answers only, never a contact detail', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    await user.click(await screen.findByRole('button', { name: 'Summarize again' }))
    await waitFor(() => expect(summarizeReport).toHaveBeenCalledWith('f_test', expect.anything()))
    const [, request] = summarizeReport.mock.calls[0] ?? []
    // (real responses only, whatever the view includes)
    expect(getResponses).toHaveBeenCalledWith('f_test', expect.objectContaining({ includeTest: false }), expect.anything())
    // (the newest response it read, and no count of the view: the server counts the answers it reads)
    expect(request).toMatchObject({ answers: [{ response_id: 'fb_3', text: 'Loved the labs' }], lastResponseAt: '2026-11-18' })
    const sent = JSON.stringify(request)
    // (no contact address, the fixtures' p@ and q@, and no count of the view)
    expect([/[pq]@/.test(sent), sent.includes('"responses"')]).toStrictEqual([false, false])
  })

  it('splits only the forms compared: one form split on its own is the Report\'s segments', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    const compare = await screen.findByRole('region', { name: 'Compare' })
    expect(within(compare).getByLabelText('Split by')).toBeDisabled()
    await user.click(await within(compare).findByRole('checkbox', { name: /Other workshop/ }))
    expect(within(compare).getByLabelText('Split by')).toBeEnabled()
    expect(compareForms).toHaveBeenCalledTimes(1)
  })

  it('prints the one-page PDF', async () => {
    const user = userEvent.setup()
    openPrintWindow.mockReturnValue(window)
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    await user.click(await screen.findByRole('button', { name: 'Download PDF' }))
    expect(openPrintWindow).toHaveBeenCalledWith(expect.objectContaining({ title: 'Example Ltd workshop: report' }))
  })

  it('compares with a form of the same template, saying where a question was asked differently', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ResultsTab />, REPORT_FORM, { rest: ['report'] })
    const compare = await screen.findByRole('region', { name: 'Compare' })
    expect(within(compare).queryByRole('checkbox', { name: /This one/ })).not.toBeInTheDocument()
    await user.click(await within(compare).findByRole('checkbox', { name: /Other workshop/ }))
    await waitFor(() => expect(compareForms).toHaveBeenLastCalledWith('f_test', expect.anything(), ['f_other'], null))
    const table = await within(compare).findByRole('table', { name: 'Scores by form' })
    expect(within(table).getByRole('row', { name: /^Other workshop/ })).toHaveTextContent('Asked differently')
    // (a point withheld with a small merged one says why)
    expect(within(table).getByRole('row', { name: /Sample Co/ })).toHaveTextContent("Hidden with the small group, so its scores can't be worked out")
  })
})
