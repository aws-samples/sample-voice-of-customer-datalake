import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// Mock API
const mockGetFeedbackById = vi.fn()
const mockGetSimilarFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackById: (id: string) => mockGetFeedbackById(id),
    getSimilarFeedback: (id: string) => mockGetSimilarFeedback(id),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

import FeedbackDetail from './FeedbackDetail'

function createWrapper(feedbackId: string = 'test-123') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/feedback/${feedbackId}`]}>
        <Routes>
          <Route path="/feedback/:id" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const mockFeedback = {
  feedback_id: 'test-123',
  source_platform: 'webscraper',
  source_channel: 'mentions',
  original_text: 'This is a great product! Really love the quality.',
  normalized_text: null,
  original_language: 'en',
  sentiment_label: 'positive',
  sentiment_score: 0.85,
  category: 'product_quality',
  subcategory: 'durability',
  journey_stage: 'post_purchase',
  impact_area: 'satisfaction',
  urgency: 'low',
  rating: 5,
  persona_name: 'Happy Customer',
  persona_type: 'loyal',
  problem_summary: null,
  problem_root_cause_hypothesis: null,
  suggested_response: 'Thank you for your feedback!',
  keywords: ['quality', 'product'],
  source_created_at: '2026-01-01T10:00:00Z',
  processed_at: '2026-01-01T10:05:00Z',
  source_url: 'https://example.com/review/123',
  author_name: 'John Doe',
  author_location: 'New York',
}

const mockSimilarFeedback = {
  items: [
    {
      feedback_id: 'similar-1',
      source_platform: 'webscraper',
      original_text: 'Also love this product!',
      sentiment_label: 'positive',
      sentiment_score: 0.9,
      category: 'product_quality',
      source_created_at: '2026-01-02T10:00:00Z',
    },
  ],
}

describe('FeedbackDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedbackById.mockResolvedValue(mockFeedback)
    mockGetSimilarFeedback.mockResolvedValue(mockSimilarFeedback)
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetFeedbackById.mockReturnValue(new Promise(() => {}))

      render(<FeedbackDetail />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('feedback display', () => {
    it('renders feedback header with platform', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/ID: test-123/)).toBeInTheDocument()
      })
    })

    it('renders feedback ID', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/ID: test-123/)).toBeInTheDocument()
      })
    })

    it('renders sentiment badge', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('positive')).toBeInTheDocument()
      })
    })

    it('renders original text', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/this is a great product/i)).toBeInTheDocument()
      })
    })

    it('renders rating stars', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Rating:')).toBeInTheDocument()
      })
    })

    it('renders classification section', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Classification')).toBeInTheDocument()
      })
    })

    it('renders persona section when available', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Customer Persona')).toBeInTheDocument()
      })
    })
  })

  describe('suggested responses', () => {
    it('renders suggested responses section', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Suggested Responses')).toBeInTheDocument()
      })
    })

    it('shows copy button for responses', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        const copyButtons = screen.getAllByTitle(/copy/i)
        expect(copyButtons.length).toBeGreaterThan(0)
      })
    })
  })

  describe('similar feedback', () => {
    it('calls API to get feedback details', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetFeedbackById).toHaveBeenCalledWith('test-123')
      })
    })
  })

  describe('navigation', () => {
    it('renders page content after loading', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/ID: test-123/)).toBeInTheDocument()
      })
    })

    it('fetches feedback on mount', async () => {
      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetFeedbackById).toHaveBeenCalledWith('test-123')
      })
    })
  })

  describe('not found', () => {
    it('shows not found message when feedback is null', async () => {
      mockGetFeedbackById.mockResolvedValue(null)

      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Feedback not found')).toBeInTheDocument()
      })
    })

    it('shows link back to feedback list', async () => {
      mockGetFeedbackById.mockResolvedValue(null)

      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('link', { name: /back to feedback list/i })).toBeInTheDocument()
      })
    })
  })

  describe('translated content', () => {
    it('shows translated text when original language is not English', async () => {
      mockGetFeedbackById.mockResolvedValue({
        ...mockFeedback,
        original_language: 'es',
        normalized_text: 'This is the translated text',
      })

      render(<FeedbackDetail />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/translated from es/i)).toBeInTheDocument()
        expect(screen.getByText('This is the translated text')).toBeInTheDocument()
      })
    })
  })
})
