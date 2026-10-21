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
const mockGetMetricsOverview = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getCategories: (...args: unknown[]) => mockGetCategories(...args),
    getSentiment: (...args: unknown[]) => mockGetSentiment(...args),
    getEntities: (...args: unknown[]) => mockGetEntities(...args),
    getFeedback: (...args: unknown[]) => mockGetFeedback(...args),
    searchFeedback: (...args: unknown[]) => mockSearchFeedback(...args),
  },
  getDaysFromRange: () => 7,
  getDateRangeParams: () => ({ days: 7 }),
}))

vi.mock('../../api/metricsOverviewApi', () => ({
  getMetricsOverview: (...args: unknown[]) => mockGetMetricsOverview(...args),
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

import { restorePages, useFeedbackFilterStore } from '../../store/feedbackFilterStore'
import Categories from './Categories'

function createWrapper(initialEntries = ['/categories']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
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

/** `/metrics/overview` answer for a source-filtered window (webscraper only). */
const mockOverviewData = {
  period_days: 7,
  feedback_count: 40,
  is_partial: false,
  categories: { period_days: 7, categories: { delivery: 25, pricing: 15 } },
  sentiment: mockSentimentData,
  issues: { 'slow delivery': 12 },
}

/** The panel body is collapsed by default; open it to reach the checkboxes. */
async function openFilterPanel(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /^Filters/ })).toBeInTheDocument()
  })
  await user.click(screen.getByRole('button', { name: /^Filters/ }))
}

describe('Categories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFeedbackFilterStore.setState({ pages: restorePages({}) })
    mockGetCategories.mockResolvedValue(mockCategoriesData)
    mockGetSentiment.mockResolvedValue(mockSentimentData)
    mockGetEntities.mockResolvedValue(mockEntitiesData)
    mockGetFeedback.mockResolvedValue(mockFeedbackData)
    mockSearchFeedback.mockResolvedValue(mockFeedbackData)
    mockGetMetricsOverview.mockResolvedValue(mockOverviewData)
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
    it('renders the category distribution with counts and percentages', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Category Distribution')).toBeInTheDocument()
      })
      expect(screen.getByText('50 (50.0%)')).toBeInTheDocument() // delivery
      expect(screen.getByText('30 (30.0%)')).toBeInTheDocument() // customer_support
    })

    it('renders sentiment gauge with correct score', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        // avgSentiment = positive - negative = 60 - 15 = 45
        expect(screen.getByText('+45')).toBeInTheDocument()
      })
    })

    it('renders word cloud with keywords', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Trending Keywords')).toBeInTheDocument()
      })
    })

    it('does not render the removed duplicate sections (chips card + insights row)', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Category Distribution')).toBeInTheDocument()
      })
      expect(screen.queryByText('Select Categories to Explore')).not.toBeInTheDocument()
      expect(screen.queryByText('Top Issue')).not.toBeInTheDocument()
      expect(screen.queryByText('Least Issues')).not.toBeInTheDocument()
    })
  })

  describe('default browse-all view (issue #198 UX rationalization)', () => {
    it('shows the feedback list by default without any selection', async () => {
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Feedback Results')).toBeInTheDocument()
      })
      expect(mockGetFeedback).toHaveBeenCalled()
    })
  })

  describe('category selection via distribution rows', () => {
    it('narrows the list when a distribution row is clicked and syncs the URL', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      // 'delivery' also appears as a word-cloud keyword — target the row via
      // its unique count label instead of the ambiguous category name.
      await waitFor(() => {
        expect(screen.getByText('50 (50.0%)')).toBeInTheDocument()
      })

      await user.click(screen.getByText('50 (50.0%)'))

      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: 'delivery' }))
      })
      expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('delivery')
    })

    it('pre-selects a category from a ?category= deep-link', async () => {
      render(<Categories />, { wrapper: createWrapper(['/categories?category=delivery']) })

      await waitFor(() => {
        expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('delivery')
      })
      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: 'delivery' }))
      })
    })
  })

  describe('unified filter bar', () => {
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
    })

    it('sends urgent-only to the paginated list as a server filter', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(screen.getByRole('checkbox', { name: 'Urgent only' }))

      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ urgent: 'true' }))
      })
    })

    it('filters the analytics and the list by every selected source', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(screen.getByRole('checkbox', { name: /webscraper/i }))

      await waitFor(() => {
        expect(mockGetMetricsOverview).toHaveBeenCalledWith(
          { days: 7 },
          expect.objectContaining({ sources: ['webscraper'] }),
        )
      })
      expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ source: 'webscraper' }))
      // The distribution now reflects the filtered scan.
      await waitFor(() => {
        expect(screen.getByText('25 (62.5%)')).toBeInTheDocument()
      })
    })

    it('keeps every category selectable in the distribution while a category is picked', async () => {
      render(<Categories />, { wrapper: createWrapper(['/categories?category=delivery']) })

      await waitFor(() => {
        expect(screen.getByText('30 (30.0%)')).toBeInTheDocument()
      })
      // Category is a list filter, not an analytics facet: no overview scan.
      expect(mockGetMetricsOverview).not.toHaveBeenCalled()
    })

    it('clears all filters back to browse-all', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper(['/categories?category=delivery']) })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Clear all' }))

      await waitFor(() => {
        expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument()
      })
      // The list stays visible: browse-all is the default state
      expect(screen.getByText('Feedback Results')).toBeInTheDocument()
    })
  })

  describe('changing filters does not reload the page', () => {
    it('keeps the panel open and the earlier numbers up while the new selection loads', async () => {
      const user = userEvent.setup()
      mockGetMetricsOverview.mockReturnValue(new Promise(() => {}))
      render(<Categories />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(screen.getByRole('checkbox', { name: /webscraper/i }))
      await waitFor(() => expect(mockGetMetricsOverview).toHaveBeenCalled())

      // No full-page spinner: the panel is still expanded with the box ticked,
      // the unfiltered distribution is still on screen, and the panel says why.
      expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('checkbox', { name: /webscraper/i })).toBeChecked()
      expect(screen.getByText('50 (50.0%)')).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Updating…')
    })

    it('sends one request for several quick selections', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await openFilterPanel(user)
      await user.click(screen.getByRole('checkbox', { name: /webscraper/i }))
      await user.click(screen.getByRole('checkbox', { name: /manual import/i }))
      await user.click(screen.getByRole('checkbox', { name: 'Urgent only' }))

      await waitFor(() => expect(mockGetMetricsOverview).toHaveBeenCalled())
      expect(mockGetMetricsOverview).toHaveBeenCalledTimes(1)
      expect(mockGetMetricsOverview).toHaveBeenCalledWith(
        { days: 7 },
        expect.objectContaining({ sources: ['webscraper', 'manual_import'], urgentOnly: true }),
      )
    })
  })

  describe('keyword click populates search', () => {
    it('runs a server-side search when a trending keyword is clicked', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Trending Keywords')).toBeInTheDocument()
      })

      // 'delivery' appears both as a distribution row and a keyword — pick the
      // keyword button inside the word cloud via its tooltip title.
      const keywordButton = screen.getAllByTitle(/mentions - click to search/)[0]
      const keyword = keywordButton.textContent ?? ''
      await user.click(keywordButton)

      expect(screen.getByPlaceholderText('Search feedback...')).toHaveValue(keyword)
      await waitFor(() => {
        expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: keyword }))
      })
    })
  })

  describe('CSV export', () => {
    it('revokes the blob object URL after triggering the download', async () => {
      const user = userEvent.setup()
      render(<Categories />, { wrapper: createWrapper() })
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Export as CSV' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Export as CSV' }))

      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    })
  })
})
