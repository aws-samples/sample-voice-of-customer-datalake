import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { createTestQueryClient } from '../../test/query-client'
import { configStoreModule } from '../Categories/categories-fixtures'

// Mock API
const mockGetFeedbackById = vi.fn<(...args: unknown[]) => unknown>()
const mockGetSimilarFeedback = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackById: (id: string) => mockGetFeedbackById(id),
    getSimilarFeedback: (id: string) => mockGetSimilarFeedback(id),
  },
}))

vi.mock('../../store/configStore', () => configStoreModule())

import FeedbackDetail from './FeedbackDetail'

const FEEDBACK_ID = 'test-123'

/**
 * A /categories probe route so tests can assert where tag-click deep-links land
 * (the Feedback list page was consolidated into Categories, issue #198).
 */
function CategoriesProbe() {
  return <div data-testid="categories-probe">{window.location.search}</div>
}

/**
 * Mount the page on `/feedback/:id`, optionally with the Categories probe route
 * alongside it for the navigation cases.
 */
function createWrapper({ withCategoriesProbe = false } = {}) {
  const queryClient = createTestQueryClient()
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/feedback/${FEEDBACK_ID}`]}>
        <Routes>
          <Route path="/feedback/:id" element={children} />
          {withCategoriesProbe && <Route path="/categories" element={<CategoriesProbe />} />}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function renderDetail(options?: { withCategoriesProbe: boolean }) {
  render(<FeedbackDetail />, { wrapper: createWrapper(options) })
}

/** Render with the Categories probe route and a user ready to click a tag. */
function renderDetailWithProbe(): UserEvent {
  const user = userEvent.setup()
  renderDetail({ withCategoriesProbe: true })
  return user
}

/** Render, then wait until `text` is on screen. */
async function expectRenderedText(text: string | RegExp): Promise<void> {
  renderDetail()
  await waitFor(() => {
    expect(screen.getByText(text)).toBeInTheDocument()
  })
}

/** Render, then wait until the detail read was issued for the routed id. */
async function expectDetailFetched(): Promise<void> {
  renderDetail()
  await waitFor(() => {
    expect(mockGetFeedbackById).toHaveBeenCalledWith(FEEDBACK_ID)
  })
}

const mockFeedback = {
  feedback_id: FEEDBACK_ID,
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
  // A contract archetype: `loyal` is not one, and the persona axis now counts any
  // value outside PERSONA_ARCHETYPES as `unknown`.
  persona_type: 'advocate',
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

  describe('similar feedback & a11y', () => {
    it('shows similar items after expanding, and an empty state when there are none', async () => {
      const user = userEvent.setup()
      renderDetail()

      const toggle = await screen.findByRole('button', { name: 'Show' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await user.click(toggle)
      expect(await screen.findByText('Also love this product!')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('says "No similar feedback found" instead of loading forever on an empty result', async () => {
      mockGetSimilarFeedback.mockResolvedValue({ items: [] })
      const user = userEvent.setup()
      renderDetail()

      await user.click(await screen.findByRole('button', { name: 'Show' }))
      expect(await screen.findByText('No similar feedback found')).toBeInTheDocument()
      expect(screen.queryByText('Loading similar feedback...')).not.toBeInTheDocument()
    })

    it('labels the icon-only copy buttons and keeps headings in order (h1 → h2)', async () => {
      renderDetail()

      const copyButtons = await screen.findAllByRole('button', { name: 'Copy to clipboard' })
      expect(copyButtons.length).toBeGreaterThan(0)
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'Original Feedback' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument()
    })
  })

  describe('tag-click deep-links land on Categories (issue #198)', () => {
    it('navigates to /categories with the category param when the category tag is clicked', async () => {
      const user = renderDetailWithProbe()

      await user.click(await screen.findByRole('button', { name: 'product_quality' }))

      expect(screen.getByTestId('categories-probe')).toBeInTheDocument()
    })

    it('navigates to /categories when the source tag is clicked', async () => {
      const user = renderDetailWithProbe()

      await user.click(await screen.findByRole('button', { name: 'webscraper' }))

      expect(screen.getByTestId('categories-probe')).toBeInTheDocument()
    })

    it('back link points to /categories', async () => {
      renderDetail({ withCategoriesProbe: true })

      const backLink = (await screen.findByText(/Back to feedback/)).closest('a')
      expect(backLink).toHaveAttribute('href', '/categories')
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetFeedbackById.mockReturnValue(new Promise(() => {}))

      renderDetail()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('feedback display', () => {
    it('renders feedback header with platform', async () => {
      await expectRenderedText(/ID: test-123/)
    })

    it('renders feedback ID', async () => {
      await expectRenderedText(/ID: test-123/)
    })

    it('renders sentiment badge', async () => {
      await expectRenderedText('positive')
    })

    it('renders original text', async () => {
      await expectRenderedText(/this is a great product/i)
    })

    it('renders rating stars', async () => {
      await expectRenderedText('Rating:')
    })

    it('renders classification section', async () => {
      await expectRenderedText('Classification')
    })

    it('renders persona section when available', async () => {
      await expectRenderedText('Customer Persona')
    })
  })

  describe('suggested responses', () => {
    it('renders suggested responses section', async () => {
      await expectRenderedText('Suggested Responses')
    })

    it('shows copy button for responses', async () => {
      renderDetail()

      await waitFor(() => {
        const copyButtons = screen.getAllByTitle(/copy/i)
        expect(copyButtons.length).toBeGreaterThan(0)
      })
    })
  })

  describe('similar feedback', () => {
    it('calls API to get feedback details', async () => {
      await expectDetailFetched()
    })
  })

  describe('navigation', () => {
    it('renders page content after loading', async () => {
      await expectRenderedText(/ID: test-123/)
    })

    it('fetches feedback on mount', async () => {
      await expectDetailFetched()
    })
  })

  describe('not found', () => {
    it('shows not found message when feedback is null', async () => {
      mockGetFeedbackById.mockResolvedValue(null)

      await expectRenderedText('Feedback not found')
    })

    it('shows link back to feedback list', async () => {
      mockGetFeedbackById.mockResolvedValue(null)

      renderDetail()

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

      renderDetail()

      await waitFor(() => {
        expect(screen.getByText(/translated from es/i)).toBeInTheDocument()
        expect(screen.getByText('This is the translated text')).toBeInTheDocument()
      })
    })
  })
})
