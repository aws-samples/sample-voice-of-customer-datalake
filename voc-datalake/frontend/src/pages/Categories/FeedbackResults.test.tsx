import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../test/test-utils'
import userEvent from '@testing-library/user-event'
import { feedbackItem } from './categories-fixtures'
import { FeedbackResults } from './FeedbackResults'
import type { FeedbackItem } from '../../api/types'

const mockFeedback: FeedbackItem[] = [
  feedbackItem({ original_text: 'Great delivery service!' }),
  feedbackItem({
    feedback_id: '2',
    source_platform: 'manual_import',
    original_text: 'Slow support response',
    sentiment_label: 'negative',
    sentiment_score: -0.7,
    category: 'customer_support',
    source_created_at: '2026-01-02T10:00:00Z',
    rating: 2,
    problem_summary: 'Slow response',
    processed_at: '2026-01-02T10:00:00Z',
  }),
]

const defaultProps: ComponentProps<typeof FeedbackResults> = {
  filteredFeedback: mockFeedback,
  feedbackLoading: false,
  viewMode: 'grid',
  onViewModeChange: vi.fn(),
  selectedSources: [],
  selectedCategories: ['delivery'],
  selectedSentiments: [],
  selectedUsefulness: [],
  ratingFilter: { value: 0, direction: 'up' },
  onExport: vi.fn(),
  totalCount: 2,
  isPartialWindow: false,
  hasMore: false,
  onLoadMore: vi.fn(),
  isLoadingMore: false,
}

function renderWithRouter(ui: React.ReactElement) {
  return render(ui)
}

describe('FeedbackResults', () => {
  describe('header display', () => {
    it('says the count once, in words, when everything is shown', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={2} />)
      expect(screen.getByText('2 reviews')).toBeInTheDocument()
      expect(screen.queryByText('(2)')).not.toBeInTheDocument()
    })

    it('shows selected categories in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedCategories={['delivery', 'pricing']} />)
      expect(screen.getByText(/Delivery, Pricing/)).toBeInTheDocument()
    })

    it('shows selected source in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedSources={['webscraper']} />)
      expect(screen.getByText(/Source: Web scraper/)).toBeInTheDocument()
    })

    it('names every selected source, sentiment and usefulness band', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedSources={['webscraper', 'feedback_form']}
        selectedSentiments={['negative', 'mixed']} selectedUsefulness={['high', 'unrated']} />)
      expect(screen.getByText(/Source: Web scraper, .+ • Delivery • Negative, Mixed • High usefulness, Not scored/)).toBeInTheDocument()
    })

    it('shows the localized sentiment filter in the subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedSentiments={['positive']} filteredFeedback={[]} />)
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
    it('says "N shown of TOTAL" when the server counted more than is loaded', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={40} />)
      expect(screen.getByText('2 shown of 40')).toBeInTheDocument()
    })

    it('says to narrow the filters when the server capped the window', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={100} isPartialWindow={true} />)
      expect(screen.getByText('2 shown · narrow the filters to see the rest')).toBeInTheDocument()
    })

    it('says nothing is missing when the partial window has no extra matches', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={2} isPartialWindow={true} />)
      expect(screen.getByText('2 reviews')).toBeInTheDocument()
      expect(screen.queryByText(/narrow the filters/)).not.toBeInTheDocument()
    })

    it('points to Load more instead of "N of N+" when another page exists', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} totalCount={200} isPartialWindow={true} hasMore={true} />)
      expect(screen.getByText('2 shown · Load more below')).toBeInTheDocument()
      expect(screen.queryByText(/\+/)).not.toBeInTheDocument()
    })

    it('shows a skeleton, never "0 of 0", while the list loads', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} filteredFeedback={[]} totalCount={0} feedbackLoading />)
      expect(screen.getByTestId('results-count-skeleton')).toBeInTheDocument()
      expect(screen.queryByText(/0 reviews|of 0/)).not.toBeInTheDocument()
    })

    it('shows the subcategory filter as a labelled chip that removes it', async () => {
      const user = userEvent.setup()
      const onClear = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} selectedCategories={['delivery']} subcategory={{ id: 'late_arrival', onClear }} />)

      expect(screen.getByText('Subcategory: Late arrival')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Remove the Late arrival filter' }))
      expect(onClear).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    })
  })

  describe('pagination (Load more)', () => {
    it('shows a Load more button when more pages exist and fires onLoadMore', async () => {
      const user = userEvent.setup()
      const onLoadMore = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} hasMore onLoadMore={onLoadMore} />)

      await user.click(screen.getByRole('button', { name: 'Load more' }))
      expect(onLoadMore).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
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
      expect(gridButton).toHaveClass('tab', 'tab-active')
      expect(screen.getByRole('button', { name: /list view/i })).not.toHaveClass('tab-active')
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
      expect(onExport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    })
  })

  describe('loading state', () => {
    it('shows skeleton cards when feedbackLoading is true', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} feedbackLoading={true} />)
      expect(screen.getAllByTestId('feedback-skeleton')).toHaveLength(4)
    })

    it('hides the skeleton when feedbackLoading is false', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} feedbackLoading={false} />)
      expect(screen.queryByTestId('feedback-skeleton')).not.toBeInTheDocument()
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
