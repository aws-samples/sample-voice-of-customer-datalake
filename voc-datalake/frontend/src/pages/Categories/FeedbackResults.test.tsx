import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { FeedbackResults } from './FeedbackResults'
import type { FeedbackItem } from '../../api/types'
import type { SentimentFilter, ViewMode } from './types'

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
  selectedKeywords: [] as string[],
  sentimentFilter: 'all' as SentimentFilter,
  minRating: 0,
  onExport: vi.fn(),
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

    it('shows selected keywords in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} selectedKeywords={['slow', 'broken']} />)
      expect(screen.getByText(/slow, broken/)).toBeInTheDocument()
    })

    it('shows sentiment filter in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} sentimentFilter="positive" filteredFeedback={[]} />)
      expect(screen.getByText(/positive/)).toBeInTheDocument()
    })

    it('shows min rating in subtitle', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} minRating={4} />)
      expect(screen.getByText(/4\+ stars/)).toBeInTheDocument()
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

  describe('export button', () => {
    it('renders export button', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} />)
      expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
    })

    it('calls onExport when export button clicked', async () => {
      const user = userEvent.setup()
      const onExport = vi.fn()
      renderWithRouter(<FeedbackResults {...defaultProps} onExport={onExport} />)

      await user.click(screen.getByRole('button', { name: /export/i }))
      expect(onExport).toHaveBeenCalledWith(expect.any(Object))
    })
  })

  describe('loading state', () => {
    it('does not show feedback items when feedbackLoading is true', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} feedbackLoading={true} />)
      expect(screen.queryByText(/great delivery service/i)).not.toBeInTheDocument()
    })

    it('shows feedback items when feedbackLoading is false', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} feedbackLoading={false} />)
      expect(screen.getByText(/great delivery service/i)).toBeInTheDocument()
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

    it('renders feedback cards in grid mode', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} viewMode="grid" />)
      expect(screen.getByText(/great delivery service/i)).toBeInTheDocument()
      expect(screen.getByText(/slow support response/i)).toBeInTheDocument()
    })

    it('renders feedback cards in list mode', () => {
      renderWithRouter(<FeedbackResults {...defaultProps} viewMode="list" />)
      expect(screen.getByText(/great delivery service/i)).toBeInTheDocument()
      expect(screen.getByText(/slow support response/i)).toBeInTheDocument()
    })
  })
})
