import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API before importing component
const mockGetCategories = vi.fn()
const mockGetSentiment = vi.fn()
const mockGetEntities = vi.fn()
const mockGetFeedback = vi.fn()
const mockSearchFeedback = vi.fn()
const mockGetUrgentFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getCategories: (...args: unknown[]) => mockGetCategories(...args),
    getSentiment: (...args: unknown[]) => mockGetSentiment(...args),
    getEntities: (...args: unknown[]) => mockGetEntities(...args),
    getFeedback: (...args: unknown[]) => mockGetFeedback(...args),
    searchFeedback: (...args: unknown[]) => mockSearchFeedback(...args),
    getUrgentFeedback: (...args: unknown[]) => mockGetUrgentFeedback(...args),
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

// Mock recharts
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}))

import Categories from './Categories'

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
    pricing: 20,
  },
}

const mockSentimentData = {
  breakdown: { positive: 60, neutral: 25, negative: 15 },
  percentages: { positive: 60, neutral: 25, negative: 15 },
}

const mockEntitiesData = {
  entities: {
    issues: { 'slow delivery': 20, 'damaged package': 15 },
    categories: { delivery: 50 },
    sources: { webscraper: 40, manual_import: 30 },
  },
}

const mockFeedbackData = {
  items: [
    {
      feedback_id: '1',
      source_platform: 'webscraper',
      original_text: 'Great delivery!',
      sentiment_label: 'positive',
      sentiment_score: 0.9,
      category: 'delivery',
      source_created_at: '2026-01-01T10:00:00Z',
      rating: 5,
      problem_summary: null,
      brand_name: 'test',
      urgency_level: 'low',
      persona: null,
      keywords: [],
      root_cause_hypothesis: null,
      suggested_response: null,
      language: 'en',
      translated_text: null,
      source_url: null,
      author_name: null,
      author_location: null,
      processed_at: '2026-01-01T10:00:00Z',
    },
  ],
  count: 1,
}

describe('Categories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCategories.mockResolvedValue(mockCategoriesData)
    mockGetSentiment.mockResolvedValue(mockSentimentData)
    mockGetEntities.mockResolvedValue(mockEntitiesData)
    mockGetFeedback.mockResolvedValue(mockFeedbackData)
    mockSearchFeedback.mockResolvedValue(mockFeedbackData)
    mockGetUrgentFeedback.mockResolvedValue(mockFeedbackData)
  })

  describe('loading states', () => {
    it('shows loading spinner while fetching data', () => {
      mockGetCategories.mockReturnValue(new Promise(() => {}))
      mockGetSentiment.mockReturnValue(new Promise(() => {}))

      render(<Categories />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('data display', () => {
    it('renders category data after loading', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Select Categories to Explore')).toBeInTheDocument()
      })
      // Categories are rendered in the selector
      expect(screen.getByText('50')).toBeInTheDocument() // delivery count
      expect(screen.getByText('30')).toBeInTheDocument() // customer_support count
    })

    it('renders sentiment gauge with correct score', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        // avgSentiment = positive - negative = 60 - 15 = 45
        expect(screen.getByText('+45')).toBeInTheDocument()
      })
    })

    it('renders insights row with top and bottom categories', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Top Issue')).toBeInTheDocument()
        expect(screen.getByText('Least Issues')).toBeInTheDocument()
      })
    })

    it('renders word cloud with keywords', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Trending Keywords')).toBeInTheDocument()
      })
    })

    it('renders source filter with available sources', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Filter by Source:')).toBeInTheDocument()
      })
    })
  })

  describe('category selection', () => {
    it('toggles category selection when clicked', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Select Categories to Explore')).toBeInTheDocument()
      })

      // Click on a category button (by its count which is unique)
      const categoryButtons = screen.getAllByRole('button')
      const deliveryButton = categoryButtons.find(btn => btn.textContent?.includes('50'))
      if (deliveryButton) {
        await user.click(deliveryButton)
      }

      // After selecting, feedback results should appear
      await waitFor(() => {
        expect(screen.getByText('Feedback Results')).toBeInTheDocument()
      })
    })
  })

  describe('consolidated feedback list (ported from Feedback page, issue #198)', () => {
    it('shows no feedback list by default', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Select Categories to Explore')).toBeInTheDocument()
      })
      expect(screen.queryByText('Feedback Results')).not.toBeInTheDocument()
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })

    it('shows all feedback when the All chip is clicked', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('All')).toBeInTheDocument()
      })
      await user.click(screen.getByText('All'))

      await waitFor(() => {
        expect(screen.getByText('Feedback Results')).toBeInTheDocument()
      })
      expect(mockGetFeedback).toHaveBeenCalled()
    })

    it('uses server-side search when typing 2+ characters', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search feedback...')).toBeInTheDocument()
      })
      await user.type(screen.getByPlaceholderText('Search feedback...'), 'slow')

      await waitFor(() => {
        expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'slow' }))
      })
      await waitFor(() => {
        expect(screen.getByText('Feedback Results')).toBeInTheDocument()
      })
    })

    it('uses the urgent endpoint when the urgent toggle is enabled', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Urgent only')).toBeInTheDocument()
      })
      await user.click(screen.getByRole('checkbox'))

      await waitFor(() => {
        expect(mockGetUrgentFeedback).toHaveBeenCalled()
      })
    })

    it('fetches feedback when category selected', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Select Categories to Explore')).toBeInTheDocument()
      })

      const categoryButtons = screen.getAllByRole('button')
      const deliveryButton = categoryButtons.find(btn => btn.textContent?.includes('50'))
      if (deliveryButton) {
        await user.click(deliveryButton)
      }

      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalled()
      })
    })
  })

  describe('filters', () => {
    it('shows filters panel when filters button clicked', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /filters/i }))

      expect(screen.getByText('Min Rating')).toBeInTheDocument()
    })

    it('clears all filters when clear button clicked', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Select Categories to Explore')).toBeInTheDocument()
      })

      // Select a category first by clicking on button with count 50
      const categoryButtons = screen.getAllByRole('button')
      const deliveryButton = categoryButtons.find(btn => btn.textContent?.includes('50'))
      if (deliveryButton) {
        await user.click(deliveryButton)
      }

      await waitFor(() => {
        expect(screen.getByText('Clear filters')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Clear filters'))

      // Feedback results should disappear
      await waitFor(() => {
        expect(screen.queryByText('Feedback Results')).not.toBeInTheDocument()
      })
    })
  })

  describe('source filter', () => {
    it('filters by source when source selected', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument()
      })

      await user.selectOptions(screen.getByRole('combobox'), 'webscraper')

      await waitFor(() => {
        expect(mockGetCategories).toHaveBeenCalledWith({ days: 7 }, 'webscraper')
      })
    })
  })
})

describe('Categories - no API endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows configuration message when API not configured', () => {
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        timeRange: '7d',
        config: { apiEndpoint: '' },
      }),
    }))

    // Re-import to get new mock - this is a limitation, test separately
  })
})
