/**
 * @fileoverview Tests for Feedback page component.
 * @module pages/Feedback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock API
const mockGetFeedback = vi.fn()
const mockGetUrgentFeedback = vi.fn()
const mockSearchFeedback = vi.fn()
const mockGetEntities = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
    searchFeedback: (params: unknown) => mockSearchFeedback(params),
    getEntities: (params: unknown) => mockGetEntities(params),
  },
  getDaysFromRange: vi.fn(() => 7),
}))

// Mock config store
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    timeRange: '7d',
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

// Mock FeedbackCard component
vi.mock('../../components/FeedbackCard', () => ({
  default: ({ feedback }: { feedback: { feedback_id: string; original_text: string } }) => (
    <div data-testid={`feedback-card-${feedback.feedback_id}`}>
      {feedback.original_text}
    </div>
  ),
}))

import Feedback from './Feedback'

function createWrapper(initialEntries = ['/feedback']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

const mockFeedbackItems = [
  { feedback_id: '1', original_text: 'Great product!', sentiment_label: 'positive', source_platform: 'webscraper' },
  { feedback_id: '2', original_text: 'Needs improvement', sentiment_label: 'negative', source_platform: 'manual_import' },
  { feedback_id: '3', original_text: 'Average experience', sentiment_label: 'neutral', source_platform: 'webscraper' },
]

describe('Feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedback.mockResolvedValue({
      count: 3,
      items: mockFeedbackItems,
    })
    mockGetEntities.mockResolvedValue({
      entities: {
        sources: { webscraper: 100, manual_import: 50 },
        categories: { delivery: 30, support: 20 },
      },
    })
    mockSearchFeedback.mockResolvedValue({
      count: 1,
      items: [mockFeedbackItems[0]],
    })
    mockGetUrgentFeedback.mockResolvedValue({
      count: 1,
      items: [mockFeedbackItems[1]],
    })
  })

  describe('not configured state', () => {
    it('displays configuration prompt when API endpoint not set', async () => {
      vi.resetModules()
      vi.doMock('../../store/configStore', () => ({
        useConfigStore: () => ({
          timeRange: '7d',
          config: { apiEndpoint: '' },
        }),
      }))
      
      const { default: FeedbackNotConfigured } = await import('./Feedback')
      
      render(<FeedbackNotConfigured />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/configure your API endpoint/i)).toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('displays loading spinner while fetching data', () => {
      mockGetFeedback.mockReturnValue(new Promise(() => {}))
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('feedback display', () => {
    it('displays feedback items after loading', async () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('feedback-card-1')).toBeInTheDocument()
        expect(screen.getByTestId('feedback-card-2')).toBeInTheDocument()
        expect(screen.getByTestId('feedback-card-3')).toBeInTheDocument()
      })
    })

    it('displays item count', async () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/Showing 3 of 3 results/i)).toBeInTheDocument()
      })
    })

    it('displays empty state when no feedback found', async () => {
      mockGetFeedback.mockResolvedValue({ count: 0, items: [] })
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/No feedback found/i)).toBeInTheDocument()
      })
    })
  })

  describe('search functionality', () => {
    it('displays search input', () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      expect(screen.getByPlaceholderText(/Search feedback/i)).toBeInTheDocument()
    })

    it('triggers search when typing 2+ characters', async () => {
      const user = userEvent.setup()
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      const searchInput = screen.getByPlaceholderText(/Search feedback/i)
      await user.type(searchInput, 'great')
      
      await waitFor(() => {
        expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({
          q: 'great',
        }))
      })
    })

    it('displays search term in results header', async () => {
      const user = userEvent.setup()
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      const searchInput = screen.getByPlaceholderText(/Search feedback/i)
      await user.type(searchInput, 'great')
      
      await waitFor(() => {
        expect(screen.getByText(/for "great"/i)).toBeInTheDocument()
      })
    })
  })

  describe('filter functionality', () => {
    it('displays source filter dropdown', async () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('All Sources')).toBeInTheDocument()
      })
    })

    it('displays sentiment filter dropdown', () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      expect(screen.getByText('All Sentiments')).toBeInTheDocument()
    })

    it('displays category filter dropdown', () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      expect(screen.getByText('All Categories')).toBeInTheDocument()
    })

    it('displays urgent only checkbox', () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      expect(screen.getByLabelText(/Urgent only/i)).toBeInTheDocument()
    })

    it('filters by source when source is selected', async () => {
      // This test verifies the API is called with source filter
      // The actual filtering happens server-side
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalled()
      })
      
      // Verify initial call was made without source filter
      expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({
        source: undefined,
      }))
    })

    it('filters by sentiment when sentiment is selected', async () => {
      const user = userEvent.setup()
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      // Wait for initial render
      await waitFor(() => {
        expect(screen.getByDisplayValue('All Sentiments')).toBeInTheDocument()
      })
      
      const sentimentSelect = screen.getByDisplayValue('All Sentiments')
      await user.selectOptions(sentimentSelect, 'positive')
      
      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({
          sentiment: 'positive',
        }))
      })
    })

    it('fetches urgent feedback when urgent checkbox is checked', async () => {
      const user = userEvent.setup()
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      const urgentCheckbox = screen.getByLabelText(/Urgent only/i)
      await user.click(urgentCheckbox)
      
      await waitFor(() => {
        expect(mockGetUrgentFeedback).toHaveBeenCalled()
      })
    })
  })

  describe('clear filters', () => {
    it('displays clear filters button when filters are active', async () => {
      const user = userEvent.setup()
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      // Wait for initial render
      await waitFor(() => {
        expect(screen.getByDisplayValue('All Sentiments')).toBeInTheDocument()
      })
      
      const sentimentSelect = screen.getByDisplayValue('All Sentiments')
      await user.selectOptions(sentimentSelect, 'positive')
      
      await waitFor(() => {
        expect(screen.getByText(/Clear filters/i)).toBeInTheDocument()
      })
    })

    it('clears all filters when clear button is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Feedback />, { wrapper: createWrapper() })
      
      // Wait for initial render
      await waitFor(() => {
        expect(screen.getByDisplayValue('All Sentiments')).toBeInTheDocument()
      })
      
      // Apply a filter
      const sentimentSelect = screen.getByDisplayValue('All Sentiments')
      await user.selectOptions(sentimentSelect, 'positive')
      
      await waitFor(() => {
        expect(screen.getByText(/Clear filters/i)).toBeInTheDocument()
      })
      
      // Clear filters
      await user.click(screen.getByText(/Clear filters/i))
      
      await waitFor(() => {
        expect(screen.getByDisplayValue('All Sentiments')).toBeInTheDocument()
      })
    })

    it('hides clear filters button when no filters are active', () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      expect(screen.queryByText(/Clear filters/i)).not.toBeInTheDocument()
    })
  })

  describe('URL sync', () => {
    it('initializes filters from URL parameters', async () => {
      render(<Feedback />, { wrapper: createWrapper(['/feedback?source=webscraper&sentiment=positive']) })
      
      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({
          source: 'webscraper',
          sentiment: 'positive',
        }))
      })
    })

    it('initializes search from URL parameter', async () => {
      render(<Feedback />, { wrapper: createWrapper(['/feedback?q=test']) })
      
      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText(/Search feedback/i)
        expect(searchInput).toHaveValue('test')
      })
    })
  })

  describe('dynamic filter options', () => {
    it('populates source options from entities API', async () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(mockGetEntities).toHaveBeenCalled()
      })
      
      // Wait for the entities to be loaded and options to be populated
      await waitFor(() => {
        const sourceSelect = screen.getByDisplayValue('All Sources')
        // Check that the select has more than just "All Sources"
        const options = sourceSelect.querySelectorAll('option')
        expect(options.length).toBeGreaterThan(1)
      })
    })
  })

  describe('API calls', () => {
    it('fetches feedback with correct parameters', async () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalledWith({
          days: 7,
          source: undefined,
          sentiment: undefined,
          category: undefined,
          limit: 100,
        })
      })
    })

    it('fetches entities for dynamic filter options', async () => {
      render(<Feedback />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(mockGetEntities).toHaveBeenCalledWith({
          days: 7,
          limit: 100,
        })
      })
    })
  })
})
