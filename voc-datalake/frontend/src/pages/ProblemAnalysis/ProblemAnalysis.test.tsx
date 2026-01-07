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

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    getEntities: (params: unknown) => mockGetEntities(params),
  },
  getDaysFromRange: () => 7,
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
    source_platform: 'twitter',
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
    source_platform: 'trustpilot',
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
  {
    feedback_id: 'f3',
    source_platform: 'twitter',
    brand_name: 'TestBrand',
    original_text: 'Product quality is poor',
    category: 'product',
    subcategory: 'quality',
    problem_summary: 'Poor product quality',
    problem_root_cause_hypothesis: 'Manufacturing issues',
    sentiment_score: -0.7,
    sentiment_label: 'negative',
    urgency: 'high',
    source_created_at: '2025-01-03',
  },
]

const mockEntities = {
  entities: {
    categories: { delivery: 10, product: 5 },
    sources: { twitter: 15, trustpilot: 8 },
  },
}

describe('ProblemAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 3 })
    mockGetEntities.mockResolvedValue(mockEntities)
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

    it('renders filter controls', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: '' })).toBeInTheDocument() // Source filter
      })
    })

    it('renders expand/collapse buttons', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument()
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
    it('groups feedback by category', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
        expect(screen.getByText('product')).toBeInTheDocument()
      })
    })

    it('shows item counts for categories', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        // Should show subcategory and review counts
        expect(screen.getByText(/sub/)).toBeInTheDocument()
        expect(screen.getByText(/reviews/)).toBeInTheDocument()
      })
    })
  })

  describe('expand/collapse', () => {
    it('expands category when clicked', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      await user.click(screen.getByText('delivery'))

      await waitFor(() => {
        expect(screen.getByText('shipping speed')).toBeInTheDocument()
      })
    })

    it('expand all button expands all categories', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /expand/i }))

      await waitFor(() => {
        expect(screen.getByText('shipping speed')).toBeInTheDocument()
        expect(screen.getByText('quality')).toBeInTheDocument()
      })
    })

    it('collapse all button collapses all categories', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      // First expand
      await user.click(screen.getByRole('button', { name: /expand/i }))
      await waitFor(() => {
        expect(screen.getByText('shipping speed')).toBeInTheDocument()
      })

      // Then collapse
      await user.click(screen.getByRole('button', { name: /collapse/i }))
      await waitFor(() => {
        expect(screen.queryByText('shipping speed')).not.toBeInTheDocument()
      })
    })
  })

  describe('filtering', () => {
    it('filters by urgent only', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      const urgentCheckbox = screen.getByRole('checkbox', { name: /urgent only/i })
      await user.click(urgentCheckbox)

      // Should still show categories with urgent items
      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })
    })

    it('clears filters when clear button clicked', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      // Enable urgent filter
      await user.click(screen.getByRole('checkbox', { name: /urgent only/i }))

      // Clear button should appear
      const clearButton = screen.getByRole('button', { name: /clear/i })
      await user.click(clearButton)

      // Checkbox should be unchecked
      expect(screen.getByRole('checkbox', { name: /urgent only/i })).not.toBeChecked()
    })
  })

  describe('similarity threshold', () => {
    it('renders similarity selector', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      const similaritySelect = screen.getByRole('combobox', { name: '' })
      expect(similaritySelect).toBeInTheDocument()
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above
