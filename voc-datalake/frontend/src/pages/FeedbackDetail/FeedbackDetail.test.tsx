import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { createTestQueryClient } from '../../test/query-client'
import { configStoreModule } from '../Categories/categories-fixtures'
import { ApiError } from '../../lib/errors'

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
  return <div data-testid="categories-probe">{useLocation().search}</div>
}

/** An in-app page that opens the review (so Back has somewhere to return to). */
function OpenReview() {
  const navigate = useNavigate()
  return (
    <div data-testid="problems-page">
      <button type="button" onClick={() => { void navigate(`/feedback/${FEEDBACK_ID}`) }}>open</button>
    </div>
  )
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

    it('keeps headings in order (h1 → h2)', async () => {
      renderDetail()

      expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'Original Feedback' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { level: 4 })).not.toBeInTheDocument()
    })
  })

  describe('tag-click deep-links land on Categories (issue #198)', () => {
    it('navigates to /categories with the category param when the category tag is clicked', async () => {
      const user = renderDetailWithProbe()

      await user.click(await screen.findByRole('button', { name: 'Product quality' }))

      // The chip reads the label; the deep-link still carries the stored id.
      expect(screen.getByTestId('categories-probe')).toHaveTextContent('?category=product_quality')
    })

    it('filters by the subcategory (inside its category) when the subcategory tag is clicked, never a raw-id search', async () => {
      const user = renderDetailWithProbe()

      await user.click(await screen.findByRole('button', { name: 'Durability' }))

      expect(screen.getByTestId('categories-probe')).toHaveTextContent('?category=product_quality&subcategory=durability')
      expect(screen.getByTestId('categories-probe')).not.toHaveTextContent('q=')
    })

    it('navigates to /categories when the source tag is clicked', async () => {
      const user = renderDetailWithProbe()

      await user.click(await screen.findByRole('button', { name: 'Webscraper' }))

      expect(screen.getByTestId('categories-probe')).toHaveTextContent('?source=webscraper')
    })

    it('back link points to /categories', async () => {
      renderDetail({ withCategoriesProbe: true })

      const backLink = (await screen.findByText(/Back to feedback/)).closest('a')
      expect(backLink).toHaveAttribute('href', '/categories')
    })

    // Labels vs status (design system rule 15): the category is the one accent
    // chip; subcategory and source are neutral clickable chips, and persona and
    // journey stage neutral labels — no info / aim tint tells them apart.
    it('emphasises only the category chip among the tags & filters', async () => {
      renderDetail()

      expect(await screen.findByRole('button', { name: 'Product quality' })).toHaveClass('bg-accent-subtle', 'text-accent-text')
      expect(screen.getByRole('button', { name: 'Durability' })).toHaveClass('bg-bg-hover', 'text-text')
      expect(screen.getByRole('button', { name: 'Webscraper' })).toHaveClass('bg-bg-hover', 'text-text')
      expect(document.querySelectorAll('.bg-info-subtle, .bg-aim-subtle, .badge-info, .badge-aim')).toHaveLength(0)
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
    it('shows labels, not stored ids, for source, category, subcategory and persona type', async () => {
      renderDetail()

      expect(await screen.findByRole('heading', { level: 1, name: 'Webscraper Mentions' })).toBeInTheDocument()
      expect(screen.getByText('Product quality', { selector: 'span' })).toBeInTheDocument()
      expect(screen.getByText('Durability', { selector: 'span' })).toBeInTheDocument()
      expect(screen.getByText('Advocate')).toBeInTheDocument()
    })

    it('shows journey stage and impact area as labels, not stored ids', async () => {
      renderDetail()

      expect(await screen.findAllByText('Post purchase')).not.toHaveLength(0)
      expect(screen.getByText('Satisfaction')).toBeInTheDocument()
      expect(screen.queryByText('post_purchase')).not.toBeInTheDocument()
    })

    it('renders a Copy link control instead of the raw "ID:" line', async () => {
      await expectRenderedText('Copy link')
      expect(screen.queryByText(/ID: test-123/)).not.toBeInTheDocument()
    })

    it('renders sentiment as a word and a percent ("Positive · 85 %"), not the raw score', async () => {
      await expectRenderedText('Positive · 85%')
      expect(screen.queryByText(/0\.85/)).not.toBeInTheDocument()
    })

    it('names the language instead of showing its code', async () => {
      await expectRenderedText('Language: English')
    })

    it('shows scraped text without markdown escapes or stray bold markers', async () => {
      mockGetFeedbackById.mockResolvedValue({ ...mockFeedback, original_text: '**Great** app\\. 5\\* support\\!' })
      await expectRenderedText('Great app. 5* support!')
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

  describe('suggested responses (removed in 5.26.00)', () => {
    it('shows no canned replies and no copy-reply buttons', async () => {
      renderDetail()

      await screen.findByRole('heading', { level: 2, name: 'Original Feedback' })
      expect(screen.queryByText('Suggested Responses')).not.toBeInTheDocument()
      expect(screen.queryByText(/Thank you for taking the time/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).not.toBeInTheDocument()
    })
  })

  describe('similar feedback', () => {
    it('calls API to get feedback details', async () => {
      await expectDetailFetched()
    })
  })

  describe('navigation', () => {
    it('renders page content after loading', async () => {
      await expectRenderedText('Copy link')
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

    it('shows ONE not-found state with one way back, and asks only once for a missing id', async () => {
      mockGetFeedbackById.mockRejectedValue(new ApiError(404, 'Not found'))

      renderDetail()

      expect(await screen.findByText('Feedback not found')).toBeInTheDocument()
      expect(screen.getAllByRole('link', { name: /back to feedback/i })).toHaveLength(1)
      expect(mockGetFeedbackById).toHaveBeenCalledExactlyOnceWith(FEEDBACK_ID)
    })
  })

  describe('Back returns where the reader came from', () => {
    it('goes back in history after an in-app navigation, not to /categories', async () => {
      mockGetFeedbackById.mockResolvedValue(mockFeedback)
      const user = userEvent.setup()
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <MemoryRouter initialEntries={['/problems']}>
            <Routes>
              <Route path="/feedback/:id" element={<FeedbackDetail />} />
              <Route path="/problems" element={<OpenReview />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
      await user.click(screen.getByRole('button', { name: 'open' }))
      await user.click(await screen.findByRole('button', { name: 'Back' }))
      expect(await screen.findByTestId('problems-page')).toBeInTheDocument()
    })
  })

  describe('the text, its quote and its redaction note', () => {
    it('hides a customer quote that only repeats the text above it', async () => {
      mockGetFeedbackById.mockResolvedValue({ ...mockFeedback, direct_customer_quote: '"This is a great product! Really love the quality"' })
      renderDetail()
      await screen.findByText(mockFeedback.original_text)
      expect(document.querySelector('blockquote')).not.toBeInTheDocument()
    })

    it('keeps a quote that says something the text does not', async () => {
      mockGetFeedbackById.mockResolvedValue({ ...mockFeedback, direct_customer_quote: 'Really love the quality' })
      renderDetail()
      expect(await screen.findByText(/"Really love the quality"/)).toBeInTheDocument()
    })

    it('says a redaction as a note on the text, not a badge beside the edit buttons', async () => {
      mockGetFeedbackById.mockResolvedValue({ ...mockFeedback, pii_policy: 'redact' })
      renderDetail()
      expect(await screen.findByTestId('pii-policy-note')).toHaveTextContent('Personal data in this review was replaced')
      expect(screen.queryByText('Redacted')).not.toBeInTheDocument()
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
        expect(screen.getByText('Translated from Spanish')).toBeInTheDocument()
        expect(screen.getByText('This is the translated text')).toBeInTheDocument()
      })
    })
  })
})
