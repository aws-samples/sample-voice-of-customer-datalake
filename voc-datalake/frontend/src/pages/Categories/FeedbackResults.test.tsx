import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { FeedbackResults } from './FeedbackResults'
import type { FeedbackItem } from '../../api/client'
import type { RatingFilter, SentimentFilter, ViewMode } from './types'

const mockFeedback: FeedbackItem[] = [
  {
    feedback_id: '1',
    source_platform: 'webscraper',
    original_text: 'Great delivery service!',
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
  {
    feedback_id: '2',
    source_platform: 'manual_import',
    original_text: 'Slow support response',
    sentiment_label: 'negative',
    sentiment_score: -0.7,
    category: 'customer_support',
    source_created_at: '2026-01-02T10:00:00Z',
    rating: 2,
    problem_summary: 'Slow response',
    brand_name: 'test',
    urgency_level: 'high',
    persona: null,
    keywords: [],
    root_cause_hypothesis: null,
    suggested_response: null,
    language: 'en',
    translated_text: null,
    source_url: null,
    author_name: null,
    author_location: null,
    processed_at: '2026-01-02T10:00:00Z',
  },
]

const defaultProps = {
  filteredFeedback: mockFeedback,
  feedbackLoading: false,
  viewMode: 'grid' as ViewMode,
  onViewModeChange: vi.fn(),
  selectedSource: null as string | null,
  selectedCategories: ['delivery'],
  sentimentFilter: 'all' as SentimentFilter,
  ratingFilter: { value: 0, direction: 'up' } as RatingFilter,
  onExport: vi.fn(),
  totalCount: 2,
  isPartialWindow: false,
  hasMore: false,
  onLoadMore: vi.fn(),
  isLoadingMore: false,
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('FeedbackResults', () => {
  describe('header display', () => {
    it('renders feedback count in header', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} />)
      expect(screen.getByText('(2)')).toBeInTheDocument()
    })

    it('shows selected categories in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedCategories={['delivery', 'pricing']} />)
      expect(screen.getByText(/delivery, pricing/)).toBeInTheDocument()
    })

    it('shows selected source in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedSource="webscraper" />)
      expect(screen.getByText(/Source: webscraper/)).toBeInTheDocument()
    })

    it('shows the localized sentiment filter in the subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} sentimentFilter="positive" filteredFeedback={[]} />)
      expect(screen.getByText(/• Positive/)).toBeInTheDocument()
    })

    it('shows the & up rating filter in the subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} ratingFilter={{ value: 4, direction: 'up' }} />)
      expect(screen.getByText(/4\+ stars/)).toBeInTheDocument()
    })

    it('shows the & below rating filter in the subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} ratingFilter={{ value: 3, direction: 'below' }} />)
      expect(screen.getByText(/≤3 stars/)).toBeInTheDocument()
    })
  })

  describe('results count line (ported from Feedback page, issue #198)', () => {
    it('shows "Showing N of TOTAL" from the backend candidate window', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={40} />)
      expect(screen.getByText(/Showing 2 of 40 results/)).toBeInTheDocument()
    })

    it('shows "N+" with the narrow-filters hint when the window is partial', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={100} isPartialWindow={true} />)
      expect(screen.getByText(/Showing 2 of 100\+ results/)).toBeInTheDocument()
      expect(screen.getByText(/narrow filters to see all/)).toBeInTheDocument()
    })

    it('does not show "N+" when the partial window has no extra matches', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={2} isPartialWindow={true} />)
      expect(screen.getByText(/Showing 2 of 2 results/)).toBeInTheDocument()
      expect(screen.queryByText(/narrow filters to see all/)).not.toBeInTheDocument()
    })
  })

  describe('pagination (Load more)', () => {
    it('shows a Load more button when more pages exist and fires onLoadMore', async () => {
      const user = userEvent.setup()
      const onLoadMore = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} hasMore onLoadMore={onLoadMore} />)

      await user.click(screen.getByRole('button', { name: 'Load more' }))
      expect(onLoadMore).toHaveBeenCalledOnce()
    })

    it('hides the Load more button when everything is loaded', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} hasMore={false} />)
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    })

    it('disables the button and shows the loading label while the next page loads', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} hasMore isLoadingMore />)

      const button = screen.getByRole('button', { name: 'Loading...' })
      expect(button).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    })
  })

  describe('view mode toggle', () => {
    it('renders grid and list view buttons', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} />)
      expect(screen.getByRole('button', { name: /grid view/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /list view/i })).toBeInTheDocument()
    })

    it('calls onViewModeChange when grid button clicked', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} viewMode="list" onViewModeChange={onChange} />)

      await user.click(screen.getByRole('button', { name: /grid view/i }))
      expect(onChange).toHaveBeenCalledWith('grid')
    })

    it('calls onViewModeChange when list button clicked', async () => {
      const user = userEvent.setup()
      const onChange = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} viewMode="grid" onViewModeChange={onChange} />)

      await user.click(screen.getByRole('button', { name: /list view/i }))
      expect(onChange).toHaveBeenCalledWith('list')
    })

    it('highlights active view mode button', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} viewMode="grid" />)
      const gridButton = screen.getByRole('button', { name: /grid view/i })
      expect(gridButton).toHaveClass('bg-white', 'shadow-sm')
    })
  })

  describe('CSV export button', () => {
    it('has an accessible name even when the text label is hidden (icon-only on small screens)', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} />)
      const button = screen.getByRole('button', { name: 'Export as CSV' })
      expect(button).toHaveAttribute('title', 'Export as CSV')
    })

    it('does not render a second PDF button (single PDF export lives in the filter bar)', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} />)
      expect(screen.queryByTitle('Export as PDF')).not.toBeInTheDocument()
    })

    it('calls onExport when the CSV button is clicked', async () => {
      const user = userEvent.setup()
      const onExport = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} onExport={onExport} />)

      await user.click(screen.getByRole('button', { name: 'Export as CSV' }))
      expect(onExport).toHaveBeenCalled()
    })
  })

  describe('loading state', () => {
    it('shows loading spinner when feedbackLoading is true', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} feedbackLoading={true} />)
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })

    it('hides loading spinner when feedbackLoading is false', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} feedbackLoading={false} />)
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty message when no feedback matches filters', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} filteredFeedback={[]} />)
      expect(screen.getByText('No feedback found matching your filters')).toBeInTheDocument()
    })
  })

  describe('feedback display', () => {
    it('renders feedback cards', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} />)
      expect(screen.getByText(/great delivery service/i)).toBeInTheDocument()
      expect(screen.getByText(/slow support response/i)).toBeInTheDocument()
    })

    it('renders in grid layout when viewMode is grid', () => {
      const { container } = renderWithRouter(<FeedbackResults {...defaultProps} viewMode="grid" />)
      expect(container.querySelector('.grid')).toBeInTheDocument()
    })

    it('renders in list layout when viewMode is list', () => {
      const { container } = renderWithRouter(<FeedbackResults {...defaultProps} viewMode="list" />)
      expect(container.querySelector('.space-y-2')).toBeInTheDocument()
    })
  })
})
