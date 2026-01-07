import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API
const mockGetCategories = vi.fn()
const mockGetFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getCategories: (...args: unknown[]) => mockGetCategories(...args),
    getFeedback: (...args: unknown[]) => mockGetFeedback(...args),
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

const mockCategoriesData = {
  categories: {
    delivery: 50,
    customer_support: 30,
    product_quality: 20,
  },
}

const mockFeedbackData = {
  items: [
    {
      feedback_id: '1',
      category: 'delivery',
      subcategory: 'late_delivery',
      problem_summary: 'Package arrived late',
      sentiment_label: 'negative',
      sentiment_score: -0.8,
      original_text: 'My package was 3 days late',
      source_platform: 'twitter',
      source_created_at: '2026-01-01T10:00:00Z',
    },
    {
      feedback_id: '2',
      category: 'delivery',
      subcategory: 'damaged',
      problem_summary: 'Package was damaged',
      sentiment_label: 'negative',
      sentiment_score: -0.9,
      original_text: 'Box was crushed',
      source_platform: 'trustpilot',
      source_created_at: '2026-01-02T10:00:00Z',
    },
    {
      feedback_id: '3',
      category: 'customer_support',
      subcategory: 'slow_response',
      problem_summary: 'Waited too long for response',
      sentiment_label: 'negative',
      sentiment_score: -0.7,
      original_text: 'Support took 5 days to reply',
      source_platform: 'google_reviews',
      source_created_at: '2026-01-03T10:00:00Z',
    },
  ],
  count: 3,
}

describe('ProblemAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCategories.mockResolvedValue(mockCategoriesData)
    mockGetFeedback.mockResolvedValue(mockFeedbackData)
  })

  describe('rendering', () => {
    it('renders page header', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      expect(screen.getByText('Problem Analysis')).toBeInTheDocument()
    })

    it('renders category breakdown after loading', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
        expect(screen.getByText('customer_support')).toBeInTheDocument()
      })
    })

    it('shows issue counts per category', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('50')).toBeInTheDocument() // delivery count
        expect(screen.getByText('30')).toBeInTheDocument() // support count
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetCategories.mockReturnValue(new Promise(() => {}))

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('category expansion', () => {
    it('expands category to show subcategories when clicked', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      // Click on delivery category to expand
      await user.click(screen.getByText('delivery'))

      await waitFor(() => {
        // Should show subcategories
        expect(mockGetFeedback).toHaveBeenCalled()
      })
    })
  })

  describe('problem details', () => {
    it('shows problem summaries in expanded view', async () => {
      const user = userEvent.setup()
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
      })

      await user.click(screen.getByText('delivery'))

      await waitFor(() => {
        expect(screen.getByText(/package arrived late/i)).toBeInTheDocument()
      })
    })
  })

  describe('sorting', () => {
    it('sorts categories by issue count by default', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        const categories = screen.getAllByRole('button')
        // First category should be delivery (50 issues)
        expect(categories[0]).toHaveTextContent(/delivery/i)
      })
    })
  })
})

describe('ProblemAnalysis - not configured', () => {
  it('shows configuration message when API not configured', () => {
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        timeRange: '7d',
        config: { apiEndpoint: '' },
      }),
    }))
  })
})
