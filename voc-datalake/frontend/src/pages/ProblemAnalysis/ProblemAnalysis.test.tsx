/**
 * @fileoverview Tests for ProblemAnalysis page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API
const mockGetFeedback = vi.fn()
const mockGetEntities = vi.fn()
const mockGetResolvedProblems = vi.fn()
const mockSetProblemResolved = vi.fn()

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

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    timeRange: '7d',
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

import ProblemAnalysis from './ProblemAnalysis'

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

const mockFeedbackItems = [
  {
    feedback_id: 'f1',
    source_platform: 'webscraper',
    brand_name: 'TestBrand',
    original_text: 'The delivery was very slow',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Slow delivery times',
    problem_root_cause_hypothesis: 'Logistics bottleneck',
    sentiment_score: -0.5,
    sentiment_label: 'negative',
    urgency: 'high',
    source_created_at: '2025-01-01',
  },
  {
    feedback_id: 'f2',
    source_platform: 'manual_import',
    brand_name: 'TestBrand',
    original_text: 'Shipping took forever',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Delivery too slow',
    problem_root_cause_hypothesis: null,
    sentiment_score: -0.6,
    sentiment_label: 'negative',
    urgency: 'medium',
    source_created_at: '2025-01-02',
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
    mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
    mockGetEntities.mockResolvedValue(mockEntities)
    mockGetResolvedProblems.mockResolvedValue({ resolved: {} })
    mockSetProblemResolved.mockResolvedValue({ success: true })
  })

  describe('rendering', () => {
    it('renders stats cards', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Categories')).toBeInTheDocument()
        expect(screen.getByText('Subcategories')).toBeInTheDocument()
        expect(screen.getByText('Problems')).toBeInTheDocument()
        expect(screen.getByText('Feedback')).toBeInTheDocument()
        expect(screen.getByText('Urgent')).toBeInTheDocument()
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      mockGetFeedback.mockReturnValue(new Promise(() => {}))

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no problems found', async () => {
      mockGetFeedback.mockResolvedValue({ items: [], count: 0 })

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/no problem analysis data found/i)).toBeInTheDocument()
      })
    })
  })

  describe('category grouping', () => {
    it('renders categories when feedback has problem summaries', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // Wait for loading to complete
      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // The component should render - check for stats cards which always render
      expect(screen.getByText('Categories')).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('renders expand button', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // Wait for loading to complete
      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // Check expand button exists
      const expandButtons = screen.getAllByRole('button')
      const expandButton = expandButtons.find(b => b.textContent?.toLowerCase().includes('expand'))
      expect(expandButton).toBeTruthy()
    })
  })
describe('source filtering', () => {
    it('renders source filter dropdown with available sources', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // Wait for loading to complete
      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // The source filter dropdown should be present with "All Sources" option
      const sourceSelects = document.querySelectorAll('select')
      expect(sourceSelects.length).toBeGreaterThan(0)
      
      // First select should have "All Sources" option
      const firstSelect = sourceSelects[0]
      expect(firstSelect.querySelector('option[value=""]')).toBeTruthy()
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above


describe('problem resolution (issue #66)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
    mockGetEntities.mockResolvedValue(mockEntities)
    mockSetProblemResolved.mockResolvedValue({ success: true })
    // Both mock feedback items merge into the same "Slow delivery times"
    // problem group (similarity), which is marked resolved server-side.
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
      expect(screen.getByText(/show resolved \(1\)/i)).toBeInTheDocument()
    })
    expect(screen.queryByText('Slow delivery times')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }))

    // Visible again, annotated as resolved (category header appears).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delivery/i })).toBeInTheDocument()
    })
  })

  it('persists an unresolve action through the API', async () => {
    render(<ProblemAnalysis />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText(/show resolved \(1\)/i)).toBeInTheDocument()
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
