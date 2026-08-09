/**
 * @fileoverview Tests for useProblemFeedback (U5b).
 *
 * The defect being pinned: Problem Analysis asked `/feedback` for `limit: 500`,
 * the endpoint clamped it to 100 without saying so, and every stat card and
 * tree level was computed from that first page as if it were the whole window.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: { getFeedback: (params: unknown) => mockGetFeedback(params) },
}))

import { useProblemFeedback, MAX_AUTO_PAGES } from './useProblemFeedback'
import { FEEDBACK_PAGE_LIMIT } from '../../api/feedbackPagination'

const API_ENDPOINT = 'https://api.example.com'
const DATE_PARAMS = { days: 7 }

interface PageRequest {
  offset?: number
  limit?: number
}

/**
 * Requests the hook actually made. Recorded here rather than read back out of
 * `mock.calls`, which is `any[][]` and so cannot be inspected without a cast.
 */
let requests: PageRequest[] = []

/**
 * Serves a synthetic window of `total` rows, honouring offset/limit the way
 * `/feedback` does.
 */
function serveWindow(total: number, opts: { isPartialWindow?: boolean } = {}) {
  mockGetFeedback.mockImplementation((params: PageRequest) => {
    requests.push(params)
    const offset = params.offset ?? 0
    const limit = params.limit ?? FEEDBACK_PAGE_LIMIT
    const size = Math.max(0, Math.min(limit, total - offset))
    return Promise.resolve({
      count: size,
      total,
      offset,
      items: Array.from({ length: size }, (_, i) => ({ feedback_id: `f${offset + i}` })),
      is_partial_window: opts.isPartialWindow ?? false,
    })
  })
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function renderFeedback(apiEndpoint = API_ENDPOINT) {
  return renderHook(() => useProblemFeedback(DATE_PARAMS, apiEndpoint), {
    wrapper: createWrapper(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requests = []
  serveWindow(FEEDBACK_PAGE_LIMIT)
})

describe('useProblemFeedback', () => {
  describe('page size', () => {
    // The regression guard. Reinstating `limit: 500` makes this fail.
    it('never requests a page larger than the endpoint allows', async () => {
      serveWindow(250)
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.loadedCount).toBe(250))

      expect(requests.every((r) => (r.limit ?? 0) <= FEEDBACK_PAGE_LIMIT)).toBe(true)
      expect(requests.map((r) => r.limit)).toEqual([
        FEEDBACK_PAGE_LIMIT,
        FEEDBACK_PAGE_LIMIT,
        FEEDBACK_PAGE_LIMIT,
      ])
    })
  })

  describe('reading the whole window', () => {
    it('pages until every row in the window is loaded', async () => {
      serveWindow(250)
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.loadedCount).toBe(250))

      expect(requests.map((r) => r.offset)).toEqual([0, 100, 200])
      expect(result.current.totalCount).toBe(250)
      expect(result.current.isPartial).toBe(false)
      expect(result.current.isLoadingMore).toBe(false)
    })

    it('stops after one request when the window fits in a single page', async () => {
      serveWindow(40)
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.loadedCount).toBe(40))
      // A short page means the window is exhausted — no speculative second call.
      expect(mockGetFeedback).toHaveBeenCalledTimes(1)
      expect(result.current.isPartial).toBe(false)
    })

    it('does not treat a full final page as though more remained', async () => {
      serveWindow(FEEDBACK_PAGE_LIMIT)
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.loadedCount).toBe(FEEDBACK_PAGE_LIMIT))
      expect(mockGetFeedback).toHaveBeenCalledTimes(1)
      expect(result.current.isPartial).toBe(false)
    })

    it('reports rows already in hand even when the total lags behind them', async () => {
      // Without a post-query filter the server sizes its candidate window from
      // offset+limit, so `total` can trail the rows already returned.
      mockGetFeedback.mockResolvedValue({ count: 100, total: 50, offset: 0, items: Array.from({ length: 100 }, (_, i) => ({ feedback_id: `f${i}` })) })
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.loadedCount).toBe(100))
      expect(result.current.totalCount).toBe(100)
    })
  })

  describe('honest partiality', () => {
    it('stops at the page budget and reports the counts as partial', async () => {
      serveWindow((MAX_AUTO_PAGES + 5) * FEEDBACK_PAGE_LIMIT)
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.isPartial).toBe(true))

      expect(mockGetFeedback).toHaveBeenCalledTimes(MAX_AUTO_PAGES)
      expect(result.current.loadedCount).toBe(MAX_AUTO_PAGES * FEEDBACK_PAGE_LIMIT)
    })

    it('reports partial when the server truncated the candidate window', async () => {
      serveWindow(40, { isPartialWindow: true })
      const { result } = renderFeedback()

      await waitFor(() => expect(result.current.loadedCount).toBe(40))
      expect(result.current.isPartial).toBe(true)
    })

    it('stops paging when a page fails, and calls the result partial', async () => {
      // Regression guard for the effect loop: on failure the query settles with
      // more pages still outstanding, which would re-arm the auto-advance.
      // Reporting complete counts here would also recreate the original defect.
      mockGetFeedback
        .mockResolvedValueOnce({
          count: 100,
          total: 500,
          offset: 0,
          items: Array.from({ length: 100 }, (_, i) => ({ feedback_id: `f${i}` })),
        })
        .mockRejectedValue(new Error('boom'))

      const { result } = renderFeedback()

      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result.current.isPartial).toBe(true))

      const callsAfterFailure = mockGetFeedback.mock.calls.length
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(mockGetFeedback.mock.calls.length).toBe(callsAfterFailure)
      expect(result.current.loadedCount).toBe(100)
    })
  })

  describe('gating', () => {
    it('does not call the API until an endpoint is configured', () => {
      renderFeedback('')
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })
  })
})
