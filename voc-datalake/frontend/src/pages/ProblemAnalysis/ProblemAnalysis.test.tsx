/**
 * @fileoverview Tests for ProblemAnalysis page.
 *
 * The page is now an aggregation view over the server-built problem tree:
 * `useProblemFeedback` fetches finest-grain leaves from `getProblems` and
 * merges them client-side. These tests mock `getProblems` with a couple of
 * leaves; the feedback drill-down (`api.getFeedback`) is only reached when a
 * problem is expanded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ProblemsResponse } from '../../api/problemsApi'

const mockGetFeedback = vi.fn()
const mockGetEntities = vi.fn()
const mockGetResolvedProblems = vi.fn()
const mockSetProblemResolved = vi.fn()
const mockGetProblems = vi.fn()
const mockGetCustomFilters = vi.fn()
const mockGetCustomFieldCandidates = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    getEntities: (params: unknown) => mockGetEntities(params),
    getResolvedProblems: () => mockGetResolvedProblems(),
    setProblemResolved: (key: string, resolved: boolean) => mockSetProblemResolved(key, resolved),
  },
  getDaysFromRange: () => 7,
  getDateRangeParams: () => ({ days: 7 }),
}))

// Capture the params so a test can assert custom-field selections reach it.
vi.mock('../../api/problemsApi', () => ({
  getProblems: (...args: unknown[]) => mockGetProblems(...args),
}))

// Custom-filter config + candidates feed the custom-field groups (same as Categories).
vi.mock('../../api/customFiltersApi', () => ({
  getCustomFilters: () => mockGetCustomFilters(),
  getCustomFieldCandidates: () => mockGetCustomFieldCandidates(),
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    timeRange: '7d',
    customDays: undefined,
    dateBasis: 'processed_at',
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

import { restorePages, useFeedbackFilterStore } from '../../store/feedbackFilterStore'
import ProblemAnalysis from './ProblemAnalysis'

/** The page's filters persist in a module-level store; start every test clean. */
function resetFilterStore() {
  useFeedbackFilterStore.setState({ pages: restorePages({}) })
}

/** The filter panel body is collapsed by default; open it to reach its controls. */
async function openFilterPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Filters/ }))
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

// Two leaves in delivery/shipping_speed. Shared keyword sets merge them at the
// default 0.4 threshold; the larger-count leaf ("Slow delivery times") is the
// representative, which is what the resolution key normalizes from.
const problemsResponse: ProblemsResponse = {
  period_days: 7,
  feedback_count: 3,
  is_partial: false,
  problems: [
    {
      category: 'delivery',
      subcategory: 'shipping_speed',
      problem: 'Slow delivery times',
      keywords: ['delivery', 'slow'],
      count: 2,
      urgent_count: 1,
      avg_sentiment: -0.5,
      root_cause: 'Logistics bottleneck',
    },
    {
      category: 'delivery',
      subcategory: 'shipping_speed',
      problem: 'Delivery too slow',
      keywords: ['delivery', 'slow'],
      count: 1,
      urgent_count: 0,
      avg_sentiment: -0.6,
      root_cause: null,
    },
  ],
}

// Drill-down rows, returned by api.getFeedback when a problem is expanded.
const mockFeedbackItems = [
  {
    feedback_id: 'f1',
    source_platform: 'webscraper',
    brand_name: 'TestBrand',
    original_text: 'The delivery was very slow',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Slow delivery times',
    sentiment_score: -0.5,
    sentiment_label: 'negative',
    urgency: 'high',
    source_created_at: '2025-01-01',
  },
]

const mockEntities = {
  entities: {
    categories: { delivery: 10, product: 5 },
    sources: { webscraper: 15, manual_import: 8 },
  },
}

describe('ProblemAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFilterStore()
    mockGetProblems.mockResolvedValue(problemsResponse)
    mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 1 })
    mockGetEntities.mockResolvedValue(mockEntities)
    mockGetResolvedProblems.mockResolvedValue({ resolved: {} })
    mockSetProblemResolved.mockResolvedValue({ success: true })
    // One configured custom filter ("Tier") with suggested values.
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [{ key: 'tier', label: 'Tier' }] })
    mockGetCustomFieldCandidates.mockResolvedValue({
      candidates: [{ key: 'tier', top_values: [{ value: 'Gold' }, { value: 'Platinum' }] }],
    })
  })

  describe('custom filters', () => {
    it('passes several selected values of a custom field through to getProblems', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      // The configured "Tier" group renders once config + candidates load.
      await user.click(await screen.findByRole('checkbox', { name: 'Gold' }))
      await user.click(screen.getByRole('checkbox', { name: 'Platinum' }))

      await waitFor(() => {
        expect(mockGetProblems).toHaveBeenCalledWith(
          { days: 7 },
          expect.objectContaining({ customFields: { tier: ['Gold', 'Platinum'] } }),
        )
      })
    })
  })

  describe('rendering', () => {
    it('renders stats cards', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // `span` scopes to the stat labels: "Categories" and "Subcategories"
      // are also the filter panel's group legends.
      await waitFor(() => {
        for (const label of ['Categories', 'Subcategories', 'Problems', 'Feedback', 'Urgent']) {
          expect(screen.getByText(label, { selector: 'span' })).toBeInTheDocument()
        }
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetProblems.mockReturnValue(new Promise(() => {}))

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no problems found', async () => {
      mockGetProblems.mockResolvedValue({ ...problemsResponse, problems: [], feedback_count: 0 })

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/no problem analysis data found/i)).toBeInTheDocument()
      })
    })
  })

  describe('category grouping', () => {
    it('builds a category from the server leaves', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // The delivery category header is built from the leaves.
      expect(screen.getByRole('button', { name: /delivery/i })).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('renders expand button', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      const expandButtons = screen.getAllByRole('button')
      const expandButton = expandButtons.find(b => b.textContent?.toLowerCase().includes('expand'))
      expect(expandButton).toBeTruthy()
    })
  })

  describe('shared filter panel', () => {
    it('offers every source in the window and sends the selection to the server', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      expect(await screen.findByRole('checkbox', { name: /manual import/i })).toBeInTheDocument()
      await user.click(screen.getByRole('checkbox', { name: /webscraper/i }))

      await waitFor(() => {
        expect(mockGetProblems).toHaveBeenCalledWith(
          { days: 7 },
          expect.objectContaining({ sources: ['webscraper'] }),
        )
      })
    })

    it('keeps the panel open and the earlier tree up while a filter change loads', async () => {
      const user = userEvent.setup()
      mockGetProblems.mockResolvedValueOnce(problemsResponse).mockReturnValue(new Promise(() => {}))
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(await screen.findByRole('checkbox', { name: /webscraper/i }))
      await waitFor(() => expect(mockGetProblems).toHaveBeenCalledTimes(2))

      // The page was not swapped for a spinner: the panel is still open and the
      // previous tree is still rendered.
      expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: /delivery/i })).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Updating…')
    })

    it('shows a failed read under the panel, with a retry, instead of replacing the page', async () => {
      const user = userEvent.setup()
      mockGetProblems.mockResolvedValueOnce(problemsResponse).mockRejectedValue(new Error('boom'))
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(await screen.findByRole('checkbox', { name: /webscraper/i }))

      expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'true')
      // Zero stats would read as a finding, so they are hidden while nothing was read.
      expect(screen.queryByText('Subcategories', { selector: 'span' })).not.toBeInTheDocument()
    })

    it('narrows the tree by subcategory without asking the server', async () => {
      const user = userEvent.setup()
      mockGetProblems.mockResolvedValue({
        ...problemsResponse,
        problems: [
          ...problemsResponse.problems,
          { ...problemsResponse.problems[0], subcategory: 'packaging', problem: 'Box crushed', keywords: ['box'] },
        ],
      })
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(await screen.findByRole('checkbox', { name: /packaging/i }))
      await user.click(screen.getByRole('button', { name: 'Expand All' }))

      // Only the packaging subtree is left in the (fully expanded) tree.
      expect(await screen.findByText('Box crushed')).toBeInTheDocument()
      expect(screen.queryByText('Slow delivery times')).not.toBeInTheDocument()
      // Subcategory is a tree post-filter: the server never receives it.
      for (const [, filters] of mockGetProblems.mock.calls) {
        expect(filters).toEqual(expect.objectContaining({ subcategories: [] }))
      }
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above


describe('problem resolution (issue #66)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFilterStore()
    mockGetProblems.mockResolvedValue(problemsResponse)
    mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 1 })
    mockGetEntities.mockResolvedValue(mockEntities)
    mockSetProblemResolved.mockResolvedValue({ success: true })
    // No custom filters configured for the resolution tests.
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [] })
    mockGetCustomFieldCandidates.mockResolvedValue({ candidates: [] })
    // The merged "Slow delivery times" group is marked resolved server-side.
    mockGetResolvedProblems.mockResolvedValue({
      resolved: {
        'delivery|shipping_speed|slow delivery times': { resolved_at: '2026-07-01T00:00:00Z' },
      },
    })
  })

  it('hides resolved problems by default and shows them via the toggle', async () => {
    render(<ProblemAnalysis />, { wrapper: createWrapper() })

    // Resolved group hidden: the page falls back to its empty state.
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /show resolved \(1\)/i })).toBeInTheDocument()
    })
    expect(screen.queryByText('Slow delivery times')).not.toBeInTheDocument()
    // The empty state explains WHY the tree is empty instead of "no data".
    expect(screen.getByText(/marked resolved/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }))

    // Visible again, annotated as resolved (category header appears).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delivery/i })).toBeInTheDocument()
    })
  })

  it('persists an unresolve action through the API', async () => {
    render(<ProblemAnalysis />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /show resolved \(1\)/i })).toBeInTheDocument()
    })
    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }))

    // Expand category → subcategory to reach the problem row.
    await userEvent.click(await screen.findByRole('button', { name: /delivery/i }))
    await userEvent.click(await screen.findByRole('button', { name: /shipping speed/i }))

    await userEvent.click(await screen.findByRole('button', { name: /mark as unresolved/i }))

    expect(mockSetProblemResolved).toHaveBeenCalledWith(
      'delivery|shipping_speed|slow delivery times', false,
    )
  })
})
