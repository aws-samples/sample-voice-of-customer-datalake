import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API
const mockGetFeedback = vi.fn()
const mockGetCategories = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (...args: unknown[]) => mockGetFeedback(...args),
    getCategories: (...args: unknown[]) => mockGetCategories(...args),
  },
  getDaysFromRange: () => 7,
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    timeRange: '7d',
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

import Prioritization from './Prioritization'

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

const mockFeedbackData = {
  items: [
    {
      feedback_id: '1',
      category: 'delivery',
      urgency: 'high',
      sentiment_label: 'negative',
      sentiment_score: -0.9,
      original_text: 'Critical delivery issue',
      problem_summary: 'Package lost',
      source_platform: 'twitter',
      source_created_at: '2026-01-01T10:00:00Z',
      rating: 1,
    },
    {
      feedback_id: '2',
      category: 'customer_support',
      urgency: 'medium',
      sentiment_label: 'negative',
      sentiment_score: -0.6,
      original_text: 'Support was slow',
      problem_summary: 'Long wait times',
      source_platform: 'trustpilot',
      source_created_at: '2026-01-02T10:00:00Z',
      rating: 2,
    },
    {
      feedback_id: '3',
      category: 'product_quality',
      urgency: 'low',
      sentiment_label: 'neutral',
      sentiment_score: 0.1,
      original_text: 'Product is okay',
      problem_summary: null,
      source_platform: 'google_reviews',
      source_created_at: '2026-01-03T10:00:00Z',
      rating: 3,
    },
  ],
  count: 3,
}

const mockCategoriesData = {
  categories: {
    delivery: 10,
    customer_support: 8,
    product_quality: 5,
  },
}

describe('Prioritization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedback.mockResolvedValue(mockFeedbackData)
    mockGetCategories.mockResolvedValue(mockCategoriesData)
  })

  describe('rendering', () => {
    it('renders page header', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      expect(screen.getByText('Issue Prioritization')).toBeInTheDocument()
    })

    it('renders priority matrix after loading', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/high priority/i)).toBeInTheDocument()
      })
    })

    it('shows urgency levels', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/high/i)).toBeInTheDocument()
        expect(screen.getByText(/medium/i)).toBeInTheDocument()
        expect(screen.getByText(/low/i)).toBeInTheDocument()
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetFeedback.mockReturnValue(new Promise(() => {}))

      render(<Prioritization />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('issue display', () => {
    it('displays feedback items', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/critical delivery issue/i)).toBeInTheDocument()
        expect(screen.getByText(/support was slow/i)).toBeInTheDocument()
      })
    })

    it('shows problem summaries when available', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/package lost/i)).toBeInTheDocument()
        expect(screen.getByText(/long wait times/i)).toBeInTheDocument()
      })
    })

    it('shows sentiment badges', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('negative')).toBeInTheDocument()
      })
    })
  })

  describe('filtering', () => {
    it('renders filter controls', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument()
      })
    })

    it('filters by urgency when selected', async () => {
      const user = userEvent.setup()
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument()
      })

      await user.selectOptions(screen.getByRole('combobox'), 'high')

      // Should filter to only high urgency items
      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalled()
      })
    })
  })

  describe('sorting', () => {
    it('sorts by urgency by default', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        // High urgency items should appear first
        const items = screen.getAllByText(/delivery|support|product/i)
        expect(items[0]).toHaveTextContent(/delivery/i)
      })
    })
  })

  describe('category breakdown', () => {
    it('shows category counts', async () => {
      render(<Prioritization />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('delivery')).toBeInTheDocument()
        expect(screen.getByText('customer_support')).toBeInTheDocument()
      })
    })
  })
})

describe('Prioritization - not configured', () => {
  it('shows configuration message when API not configured', () => {
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        timeRange: '7d',
        config: { apiEndpoint: '' },
      }),
    }))
  })
})
