/**
 * Results › Summary (UX §10): a card per question with its figures, the drop-off (a funnel with the beacon, Reach
 * without), test responses left out unless asked for (and then said loudly), and CSV under the filters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const getResults = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const downloadResponsesCsv = vi.fn<(...args: unknown[]) => Promise<Blob>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  const { parseFormResults } = await import('../../../api/feedbackFormsV2Results')
  return {
    ...actual,
    feedbackFormsV2Api: {
      ...actual.feedbackFormsV2Api,
      getResults: async (...args: unknown[]) => parseFormResults(await getResults(...args)),
      downloadResponsesCsv: (...args: unknown[]) => downloadResponsesCsv(...args),
    },
  }
})

import { renderWithDraft } from '../test/draftHarness'
import { RESULTS, RESULTS_FORM } from './results-fixtures'
import ResultsTab from './ResultsTab'

const DEFAULT_FILTERS = { days: 30, language: '', ending: '', hidden: {}, includeTest: false }

/** The card of question `number`. */
async function card(number: number, headline: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name: `${String(number)} · ${headline}` })
}

describe('ResultsTab summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getResults.mockResolvedValue(RESULTS)
    downloadResponsesCsv.mockResolvedValue(new Blob(['a,b']))
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:csv'), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  })
  afterEach(() => vi.restoreAllMocks())

  it('draws a choice question as bars with counts, shares and the typed Other answers', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    const why = await card(1, 'What made you switch back?')
    expect(within(why).getByText("I can't find what I need").closest('li')).toHaveTextContent('4 · 40%')
    expect(within(why).getByText('People could pick up to 3, so the shares add up to more than 100 %.')).toBeInTheDocument()
    await user.click(within(why).getByRole('button', { name: 'Show 2 answers' }))
    expect(within(why).getByText('printing')).toBeInTheDocument()
  })

  it('gives NPS its signed score and its three groups in words', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    const nps = await card(2, 'How likely are you to recommend us?')
    expect(within(nps).getByText('+20')).toBeInTheDocument()
    expect(within(nps).getByRole('list', { name: 'NPS groups' })).toHaveTextContent('Detractors (0–6) 3 · 30%')
    expect(within(nps).getByRole('list', { name: 'NPS groups' })).toHaveTextContent('Promoters (9–10) 5 · 50%')
  })

  it('gives a rating its average and every point of its histogram', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    const rating = await card(3, 'How satisfied are you with this feature?')
    expect(within(rating).getByText('4.2 of 5')).toBeInTheDocument()
    expect(within(within(rating).getByRole('list', { name: 'Answers by score' })).getAllByRole('listitem')).toHaveLength(5)
  })

  it('says CSAT as the share satisfied and CES as its average and the share easy', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    expect(within(await card(4, 'How satisfied are you with the help?')).getByText('80%')).toBeInTheDocument()
    const ces = await card(5, 'How easy was it?')
    expect(within(ces).getByText('4.5 of 7')).toBeInTheDocument()
    expect(within(ces).getByText('50%')).toBeInTheDocument()
  })

  it('lists the latest open answers with their sentiment, and the reach line', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    const comment = await card(6, 'Anything else?')
    expect(within(comment).getByText('“The export is gone”').closest('li')).toHaveTextContent('Negative')
    expect(within(comment).getByText('“Fine otherwise”').closest('li')).toHaveTextContent('Analysing…')
    expect(within(comment).getByText('Answered 2 · Skipped 6 · Not shown 2 (logic)')).toBeInTheDocument()
  })

  it('shows Reach, and why there is no funnel, without the beacon', async () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    expect(await screen.findByRole('region', { name: 'Reach' })).toHaveTextContent('answered by 10 of 10 completed responses')
    expect(screen.getByText('How many people stop part-way needs view tracking, not yet collected.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Drop-off' })).not.toBeInTheDocument()
  })

  it('shows the funnel and its largest drop when the beacon counted', async () => {
    getResults.mockResolvedValue({ ...RESULTS, funnel: { opened: 40, started: 30, steps: [{ question_id: 'q_why', reached: 12 }], completed: 10 } })
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    const funnel = await screen.findByRole('region', { name: 'Drop-off' })
    expect(within(funnel).getByText('1 · What made you switch back?').closest('li')).toHaveTextContent('largest drop')
    expect(within(funnel).getByText('Completed').closest('li')).toHaveTextContent('25% of opened')
  })

  it('says the largest drop beside Completion, and that line moves to the funnel', async () => {
    const user = userEvent.setup()
    getResults.mockResolvedValue({ ...RESULTS, funnel: { opened: 40, started: 30, steps: [{ question_id: 'q_why', reached: 12 }], completed: 10 } })
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true })
    await user.click(await screen.findByRole('button', { name: 'largest drop at Q1' }))
    expect(screen.getByRole('heading', { name: 'Drop-off' })).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start', behavior: 'smooth' })
  })

  it('never calls a question logic shows to some people only the largest drop', async () => {
    const form = {
      ...RESULTS_FORM,
      questions: RESULTS_FORM.questions.map((question, index) => (index === 0
        ? { ...question, logic: [{ when: { op: 'includes_any' as const, value: ['cant_find'] }, then: { jump_to: 'q_nps' } }, { when: { op: 'submitted' as const }, then: { jump_to: 'q_rating' } }] }
        : question)),
    }
    getResults.mockResolvedValue({
      ...RESULTS, funnel: {
        opened: 12, started: 12, completed: 10,
        steps: [{ question_id: 'q_why', reached: 12 }, { question_id: 'q_nps', reached: 11 }, { question_id: 'q_rating', reached: 11 }],
      },
    })
    renderWithDraft(<ResultsTab />, form)
    const funnel = await screen.findByRole('region', { name: 'Drop-off' })
    const nps = within(funnel).getByText('2 · How likely are you to recommend us?').closest('li')
    expect(nps).toHaveTextContent('on some paths only')
    expect(nps).not.toHaveTextContent('largest drop')
    expect(within(funnel).getByText(/Logic shows some questions on some paths only/u)).toBeInTheDocument()
  })

  it('reads without test responses, and says so loudly once they are included', async () => {
    const user = userEvent.setup()
    getResults.mockResolvedValue({ ...RESULTS, test_count: 14 })
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    await card(1, 'What made you switch back?')
    expect(getResults).toHaveBeenCalledWith('f_test', DEFAULT_FILTERS)
    await user.click(screen.getByRole('switch', { name: 'Include test responses' }))
    expect(await screen.findByText("Including 14 test responses. These numbers aren't your real results.")).toBeInTheDocument()
    expect(getResults).toHaveBeenLastCalledWith('f_test', { ...DEFAULT_FILTERS, includeTest: true })
  })

  it('says only test responses exist, with the way to include them', async () => {
    getResults.mockResolvedValue({ ...RESULTS, total: 0, test_count: 3, questions: {} })
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    expect(await screen.findByText('3 test responses are hidden.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Include test responses' })).toBeInTheDocument()
  })

  it('says there are no responses yet, with the way to Share', async () => {
    const user = userEvent.setup()
    getResults.mockResolvedValue({ ...RESULTS, total: 0, questions: {} })
    const harness = renderWithDraft(<ResultsTab />, RESULTS_FORM)
    await user.click(await screen.findByRole('button', { name: 'Open Share' }))
    expect(harness.go).toHaveBeenCalledWith('share')
  })

  it('exports the responses as CSV under the filters', async () => {
    const user = userEvent.setup()
    // (jsdom cannot follow a download link)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue(undefined)
    renderWithDraft(<ResultsTab />, RESULTS_FORM)
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(downloadResponsesCsv).toHaveBeenCalledWith('f_test', DEFAULT_FILTERS))
  })

  it('asks a new form to be saved first', () => {
    renderWithDraft(<ResultsTab />, RESULTS_FORM, { isNew: true })
    expect(screen.getByText('Save the form to get its links.')).toBeInTheDocument()
    expect(getResults).not.toHaveBeenCalled()
  })
})
