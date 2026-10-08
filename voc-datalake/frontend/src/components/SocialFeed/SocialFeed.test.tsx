/**
 * @fileoverview Tests for SocialFeed component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TestRouter } from '../../test/TestRouter'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SocialFeed from './SocialFeed'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'

interface ConfigStub {
  timeRange: string
  customDays: number | null
  config: { apiEndpoint: string }
}
const mockUseConfigStore = vi.fn<() => ConfigStub>()
vi.mock('../../store/configStore', () => ({
  useConfigStore: () => mockUseConfigStore(),
}))

// Mock the API
vi.mock('../../api/client', () => ({
  api: {
    getFeedback: vi.fn(),
    getSources: vi.fn(),
  },
  getDateRangeParams: () => ({ days: 7 }),
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
      {/* FeedItem links to /feedback/:id, so it needs a router. */}
      <TestRouter>{ui}</TestRouter>
    </QueryClientProvider>
  )
}

/** A `GET /feedback` page holding exactly `items`. */
function feedbackPage(items: FeedbackItem[]) {
  return { items, count: items.length, total: items.length, offset: 0, limit: items.length, is_partial_window: false }
}

const mockFeedbackItems: FeedbackItem[] = [
  {
    feedback_id: 'fb-1',
    source_id: 'src-1',
    source_platform: 'webscraper',
    source_channel: 'reviews',
    source_url: 'https://example.com/review/1',
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
    source_platform: 'manual_import',
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
    mockUseConfigStore.mockReturnValue({
      timeRange: '7d',
      customDays: null,
      config: { apiEndpoint: 'https://api.example.com' },
    })
    vi.mocked(api.getFeedback).mockResolvedValue(feedbackPage(mockFeedbackItems))
    vi.mocked(api.getSources).mockResolvedValue({
      period_days: 7,
      sources: { webscraper: 10, manual_import: 5 },
    })
  })

  describe('loading state', () => {
    it('shows loading skeletons while fetching', () => {
      vi.mocked(api.getFeedback).mockReturnValue(new Promise(() => {}))
      
      renderWithQueryClient(<SocialFeed />)
      
      // `.skeleton` (index.css) carries its own pulse animation.
      const skeletons = document.querySelectorAll('.skeleton')
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
      const { container } = renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        // Once in the source filter tab, once on the feed item — each beside its icon.
        expect(screen.getAllByText('webscraper')).toHaveLength(2)
      })
      expect(container.querySelector('svg.lucide-globe')).not.toBeNull()
      expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u)
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
        const filledStars = document.querySelectorAll('.text-warn.fill-warn')
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
      expect(screen.getByRole('button', { name: /webscraper/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /manual import/i })).toBeInTheDocument()
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
        // Segmented-filter recipe: the active segment is `tab-active` and is
        // exposed to assistive tech through aria-pressed.
        expect(allButton).toHaveClass('tab', 'tab-active')
        expect(allButton).toHaveAttribute('aria-pressed', 'true')
      })
    })

    it('calls API with source filter when filter is clicked', async () => {
      const user = userEvent.setup()
      renderWithQueryClient(<SocialFeed showFilters={true} />)
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /webscraper/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /webscraper/i }))
      
      await waitFor(() => {
        expect(api.getFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ source: 'webscraper' })
        )
      })
    })
  })

  describe('empty state', () => {
    it('shows empty message when no feedback found', async () => {
      vi.mocked(api.getFeedback).mockResolvedValue(feedbackPage([]))
      
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
    it('applies correct border color for webscraper', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        const webscraperCard = document.querySelector('.border-l-chart-2')
        expect(webscraperCard).toBeInTheDocument()
      })
    })

    it('applies correct border color for manual_import', async () => {
      renderWithQueryClient(<SocialFeed />)
      
      await waitFor(() => {
        const manualImportCard = document.querySelector('.border-l-chart-1')
        expect(manualImportCard).toBeInTheDocument()
      })
    })
  })
})
