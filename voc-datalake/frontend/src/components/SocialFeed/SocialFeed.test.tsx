/**
 * @fileoverview Tests for SocialFeed component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SocialFeed from './SocialFeed'
import { useConfigStore } from '../../store/configStore'
import { api } from '../../api/client'

// Mock the config store
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(),
}))

// Mock the API
vi.mock('../../api/client', () => ({
  api: {
    getFeedback: vi.fn(),
  },
  getDaysFromRange: vi.fn().mockReturnValue(7),
}))

// Helper to render with QueryClient
function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  )
}

const mockFeedbackItems = [
  {
    feedback_id: 'fb-1',
    source_id: 'src-1',
    source_platform: 'trustpilot',
    source_channel: 'reviews',
    source_url: 'https://trustpilot.com/review/1',
    brand_name: 'TestBrand',
    source_created_at: '2025-01-15T10:00:00Z',
    processed_at: '2025-01-15T10:05:00Z',
    original_text: 'Great product, highly recommend!',
    original_language: 'en',
    rating: 5,
    category: 'product_quality',
    journey_stage: 'post_purchase',
    sentiment_label: 'positive',
    sentiment_score: 0.9,
    urgency: 'low',
    impact_area: 'product',
  },
  {
    feedback_id: 'fb-2',
    source_id: 'src-2',
    source_platform: 'twitter',
    source_channel: 'mentions',
    brand_name: 'TestBrand',
    source_created_at: '2025-01-14T15:00:00Z',
    processed_at: '2025-01-14T15:05:00Z',
    original_text: 'Not happy with the service',
    original_language: 'en',
    category: 'customer_support',
    journey_stage: 'support',
    sentiment_label: 'negative',
    sentiment_score: 0.2,
    urgency: 'high',
    impact_area: 'service',
  },
]

describe('SocialFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(useConfigStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      timeRange: '7d',
      customDateRange: null,
      config: { apiEndpoint: 'https://api.example.com' },
    })
    ;(api.getFeedback as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 2,
      items: mockFeedbackItems,
    })
  })

  describe('loading state', () => {
    it('shows loading skeletons while fetching', () => {
      ;(api.getFeedback as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
      
      renderWithQueryClient(<SocialFeed />)
      
      const skeletons = document.querySelectorAll('.animate-pulse')
      expect(skeletons.length).toBeGreaterThan(0)
    })
  })

  describe('data display', () => {
    it('renders feedback items after loading', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        expect(screen.getByText('Great product, highly recommend!')).toBeInTheDocument()
      })
      expect(screen.getByText('Not happy with the service')).toBeInTheDocument()
    })

    it('displays source platform with icon', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        expect(screen.getByText('trustpilot')).toBeInTheDocument()
      })
      expect(screen.getByText('⭐')).toBeInTheDocument()
    })

    it('displays sentiment badge', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        expect(screen.getByText('positive')).toBeInTheDocument()
      })
      expect(screen.getByText('negative')).toBeInTheDocument()
    })

    it('displays rating stars when provided', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        const filledStars = document.querySelectorAll('.text-yellow-400.fill-yellow-400')
        expect(filledStars.length).toBe(5)
      })
    })

    it('displays category', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        expect(screen.getByText('product quality')).toBeInTheDocument()
      })
    })

    it('displays external link when source_url is provided', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        const viewLinks = screen.getAllByText('View')
        expect(viewLinks.length).toBeGreaterThan(0)
      })
    })
  })

  describe('source filters', () => {
    it('renders source filter buttons when showFilters is true', async () => {
      renderWithQueryClient(<SocialFeed showFilters={true} />)
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /all/i })).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /trustpilot/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /twitter/i })).toBeInTheDocument()
    })

    it('does not render filters when showFilters is false', async () => {
      renderWithQueryClient(<SocialFeed showFilters={false} />)
      
      await waitFor(() => {
        expect(screen.getByText('Great product, highly recommend!')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /all/i })).not.toBeInTheDocument()
    })

    it('highlights active filter', async () => {
      renderWithQueryClient(<SocialFeed showFilters={true} />)
      
      await waitFor(() => {
        const allButton = screen.getByRole('button', { name: /all/i })
        expect(allButton).toHaveClass('bg-blue-600', 'text-white')
      })
    })

    it('calls API with source filter when filter is clicked', async () => {
      const user = userEvent.setup()
      renderWithQueryClient(<SocialFeed showFilters={true} />)
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /trustpilot/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /trustpilot/i }))
      
      await waitFor(() => {
        expect(api.getFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ source: 'trustpilot' })
        )
      })
    })
  })

  describe('empty state', () => {
    it('shows empty message when no feedback found', async () => {
      ;(api.getFeedback as ReturnType<typeof vi.fn>).mockResolvedValue({
        count: 0,
        items: [],
      })
      
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        expect(screen.getByText('No feedback found for this period')).toBeInTheDocument()
      })
    })
  })

  describe('limit prop', () => {
    it('passes limit to API call', async () => {
      renderWithQueryClient(<SocialFeed limit={5} />)
      
      await waitFor(() => {
        expect(api.getFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ limit: 5 })
        )
      })
    })

    it('uses default limit of 10', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        expect(api.getFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ limit: 10 })
        )
      })
    })
  })

  describe('source styling', () => {
    it('applies correct border color for trustpilot', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        const trustpilotCard = document.querySelector('.border-l-green-500')
        expect(trustpilotCard).toBeInTheDocument()
      })
    })

    it('applies correct border color for twitter', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        const twitterCard = document.querySelector('.border-l-gray-800')
        expect(twitterCard).toBeInTheDocument()
      })
    })
  })
})
