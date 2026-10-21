/**
 * @fileoverview Tests for useProblemFeedback — the server-aggregated problem
 * tree hook.
 *
 * The page used to walk `/feedback` client-side (capped at ~2000 rows, hard-
 * walled at the server's 5000 offset). The hook now fetches the server
 * aggregate once via `getProblems` and merges the leaves to the slider
 * threshold in-browser, so the whole window is covered and the slider is
 * instant. These tests pin that new contract.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetProblems = vi.fn()
vi.mock('../../api/problemsApi', () => ({
  getProblems: (...args: unknown[]) => mockGetProblems(...args),
}))

import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { useProblemFeedback } from './useProblemFeedback'
import type { ProblemLeaf } from '../../api/problemsApi'

const API_ENDPOINT = 'https://api.example.com'
const DATE_PARAMS = { days: 7 }

function leaf(partial: Partial<ProblemLeaf> & { problem: string }): ProblemLeaf {
  return {
    category: 'delivery',
    subcategory: 'late',
    keywords: [],
    count: 1,
    urgent_count: 0,
    avg_sentiment: 0,
    root_cause: null,
    ...partial,
  }
}

function serve(problems: ProblemLeaf[], opts: { is_partial?: boolean } = {}) {
  mockGetProblems.mockResolvedValue({
    period_days: 7,
    feedback_count: problems.reduce((s, p) => s + p.count, 0),
    is_partial: opts.is_partial ?? false,
    problems,
  })
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function render(threshold = 0.4, filters: FeedbackFilterState = EMPTY_FEEDBACK_FILTERS) {
  return renderHook(
    () => useProblemFeedback(DATE_PARAMS, API_ENDPOINT, threshold, filters),
    { wrapper: createWrapper(makeClient()) },
  )
}

beforeEach(() => {
  mockGetProblems.mockReset()
})

describe('useProblemFeedback', () => {
  it('does not fetch without an API endpoint', () => {
    renderHook(() => useProblemFeedback(DATE_PARAMS, '', 0.4), {
      wrapper: createWrapper(makeClient()),
    })
    expect(mockGetProblems).not.toHaveBeenCalled()
  })

  it('builds the category → subcategory → problem tree from the leaves', async () => {
    serve([
      leaf({ category: 'delivery', subcategory: 'late', problem: 'order late', count: 5, urgent_count: 2 }),
      leaf({ category: 'pricing', subcategory: 'cost', problem: 'too expensive', count: 3 }),
    ])
    const { result } = render()
    await waitFor(() => expect(result.current.categories).toHaveLength(2))
    // Biggest category first.
    expect(result.current.categories[0].category).toBe('delivery')
    expect(result.current.categories[0].totalItems).toBe(5)
    expect(result.current.categories[0].urgentCount).toBe(2)
    expect(result.current.loadedCount).toBe(8)
  })

  it('merges similar leaves within a subcategory at the threshold', async () => {
    serve([
      leaf({ problem: 'order arrived late', keywords: ['order', 'arrived', 'late'], count: 5 }),
      leaf({ problem: 'order delivered late', keywords: ['order', 'delivered', 'late'], count: 3 }),
    ])
    const { result } = render(0.3)
    await waitFor(() => expect(result.current.categories).toHaveLength(1))
    const problems = result.current.categories[0].subcategories[0].problems
    expect(problems).toHaveLength(1)
    expect(problems[0].itemCount).toBe(8)
  })

  it('a stricter threshold splits what a looser one merged', async () => {
    const leaves = [
      leaf({ problem: 'order arrived late', keywords: ['order', 'arrived', 'late'], count: 5 }),
      leaf({ problem: 'order delivered late', keywords: ['order', 'delivered', 'late'], count: 3 }),
    ]
    serve(leaves)
    const loose = render(0.3)
    await waitFor(() => expect(loose.result.current.categories[0].subcategories[0].problems).toHaveLength(1))

    serve(leaves)
    const strict = render(0.95)
    await waitFor(() => expect(strict.result.current.categories[0].subcategories[0].problems).toHaveLength(2))
  })

  it('passes the window and the filters through to the server query', async () => {
    serve([])
    const filters = { ...EMPTY_FEEDBACK_FILTERS, sources: ['webscraper', 'manual_import'], urgentOnly: true }
    render(0.4, filters)
    await waitFor(() => expect(mockGetProblems).toHaveBeenCalled())
    expect(mockGetProblems).toHaveBeenCalledWith(DATE_PARAMS, filters)
  })

  it('refetches when the filters change but not when only the threshold moves', async () => {
    serve([leaf({ problem: 'order late' })])
    const client = makeClient()
    const { rerender } = renderHook(
      ({ threshold, filters }: { threshold: number; filters: FeedbackFilterState }) =>
        useProblemFeedback(DATE_PARAMS, API_ENDPOINT, threshold, filters),
      {
        wrapper: createWrapper(client),
        initialProps: { threshold: 0.4, filters: EMPTY_FEEDBACK_FILTERS },
      },
    )
    await waitFor(() => expect(mockGetProblems).toHaveBeenCalledTimes(1))

    rerender({ threshold: 0.8, filters: EMPTY_FEEDBACK_FILTERS })
    expect(mockGetProblems).toHaveBeenCalledTimes(1)

    rerender({ threshold: 0.8, filters: { ...EMPTY_FEEDBACK_FILTERS, categories: ['delivery'] } })
    await waitFor(() => expect(mockGetProblems).toHaveBeenCalledTimes(2))
  })

  it('surfaces the partial-window flag', async () => {
    serve([leaf({ problem: 'x' })], { is_partial: true })
    const { result } = render()
    await waitFor(() => expect(result.current.isPartial).toBe(true))
  })

  it('reports an error when the fetch fails', async () => {
    mockGetProblems.mockRejectedValue(new Error('boom'))
    const { result } = render()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.categories).toEqual([])
    expect(result.current.loadedCount).toBe(0)
  })
})
