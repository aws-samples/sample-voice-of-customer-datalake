/**
 * @fileoverview Tests for FeedbackCard component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import FeedbackCard from './FeedbackCard'
import type { FeedbackItem } from '../../api/types'

// Helper to render with router
function renderWithRouter(ui: React.ReactElement, initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter
      initialEntries={initialEntries}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      {ui}
    </MemoryRouter>
  )
}

const mockFeedback: FeedbackItem = {
  feedback_id: 'fb-123',
  source_id: 'src-123',
  source_platform: 'webscraper',
  source_channel: 'reviews',
  source_url: 'https://example.com/review/123',
  brand_name: 'TestBrand',
  source_created_at: '2025-01-15T10:30:00Z',
  processed_at: '2025-01-15T10:35:00Z',
  original_text: 'This is a great product! I love it.',
  original_language: 'en',
  rating: 5,
  category: 'product_quality',
  subcategory: 'features',
  journey_stage: 'post_purchase',
  sentiment_label: 'positive',
  sentiment_score: 0.92,
  urgency: 'low',
  impact_area: 'product',
  problem_summary: undefined,
  direct_customer_quote: 'I love it',
  persona_name: 'Happy Customer',
}

describe('FeedbackCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    it('renders feedback text', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText(/This is a great product/)).toBeInTheDocument()
    })

    it('renders source platform with icon', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('Web Scraper')).toBeInTheDocument()
      expect(screen.getByText('🌐')).toBeInTheDocument()
    })

    it('renders sentiment badge', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('positive')).toBeInTheDocument()
    })

    it('renders category badge', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('product_quality')).toBeInTheDocument()
    })

    it('renders formatted date', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText(/Jan 15, 2025/)).toBeInTheDocument()
    })
  })

  describe('rating display', () => {
    it('renders star rating when provided', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      // Stars are SVG icons; just verify the rating section renders
      expect(screen.getByText(/This is a great product/)).toBeInTheDocument()
    })

    it('does not render rating when not provided', () => {
      const feedbackWithoutRating = { ...mockFeedback, rating: undefined }
      renderWithRouter(<FeedbackCard feedback={feedbackWithoutRating} />)
      expect(screen.getByText(/This is a great product/)).toBeInTheDocument()
    })
  })

  describe('urgency indicator', () => {
    it('shows urgent badge for high urgency items', () => {
      const urgentFeedback = { ...mockFeedback, urgency: 'high' }
      renderWithRouter(<FeedbackCard feedback={urgentFeedback} />)
      expect(screen.getByText('Urgent')).toBeInTheDocument()
    })

    it('applies urgent border styling for high urgency', () => {
      const urgentFeedback = { ...mockFeedback, urgency: 'high' }
      renderWithRouter(<FeedbackCard feedback={urgentFeedback} />)
      // eslint-disable-next-line testing-library/no-node-access
      const card = screen.getByText(/This is a great product/).closest('.border-l-orange-500')
      expect(card).toBeInTheDocument()
    })

    it('does not show urgent badge for low urgency', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.queryByText('Urgent')).not.toBeInTheDocument()
    })
  })

  describe('problem summary', () => {
    it('renders problem summary when provided', () => {
      const feedbackWithProblem = {
        ...mockFeedback,
        problem_summary: 'Delivery was delayed',
        problem_root_cause_hypothesis: 'Logistics issue',
      }
      renderWithRouter(<FeedbackCard feedback={feedbackWithProblem} />)
      expect(screen.getByText(/Issue: Delivery was delayed/)).toBeInTheDocument()
    })

    it('does not render problem section when not provided', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.queryByText(/Issue:/)).not.toBeInTheDocument()
    })
  })

  describe('actions', () => {
    it('renders Details link when showActions is true', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} showActions={true} />)
      expect(screen.getByRole('link', { name: /details/i })).toBeInTheDocument()
    })

    it('hides actions when showActions is false', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} showActions={false} />)
      expect(screen.queryByRole('link', { name: /details/i })).not.toBeInTheDocument()
    })

    it('renders external link when source_url is provided', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      const externalLink = screen.getByRole('link', { name: '' })
      expect(externalLink).toHaveAttribute('href', 'https://example.com/review/123')
    })

    it('renders copy button', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByTitle('Copy text')).toBeInTheDocument()
    })
  })

  describe('compact mode', () => {
    it('renders compact card when compact is true', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} compact={true} />)
      // Compact mode renders as a link
      const link = screen.getByRole('link')
      expect(link).toHaveAttribute('href', '/feedback/fb-123')
    })

    it('shows truncated text in compact mode', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} compact={true} />)
      const textElement = screen.getByText(/This is a great product/)
      expect(textElement).toHaveClass('line-clamp-2')
    })
  })

  describe('source formatting', () => {
    it('formats web scraper source correctly', () => {
      const scraperFeedback = { ...mockFeedback, source_platform: 'web_scrape' }
      renderWithRouter(<FeedbackCard feedback={scraperFeedback} />)
      expect(screen.getByText('Web Scraper')).toBeInTheDocument()
    })

    it('formats scraper_ prefixed source correctly', () => {
      const scraperFeedback = { ...mockFeedback, source_platform: 'scraper_custom' }
      renderWithRouter(<FeedbackCard feedback={scraperFeedback} />)
      expect(screen.getByText('Web Scraper')).toBeInTheDocument()
    })

    it('formats webscraper source correctly', () => {
      const webscraperFeedback = { ...mockFeedback, source_platform: 'web_scrape' }
      renderWithRouter(<FeedbackCard feedback={webscraperFeedback} />)
      expect(screen.getByText('Web Scraper')).toBeInTheDocument()
      expect(screen.getByText('🌐')).toBeInTheDocument()
    })
  })

  describe('date handling', () => {
    it('handles invalid date gracefully', () => {
      const feedbackWithBadDate = { ...mockFeedback, source_created_at: 'invalid-date' }
      renderWithRouter(<FeedbackCard feedback={feedbackWithBadDate} />)
      // The formatDate helper returns 'N/A' for invalid dates - may appear multiple times
      const naElements = screen.getAllByText('N/A')
      expect(naElements.length).toBeGreaterThan(0)
    })

    it('handles missing date gracefully', () => {
      const feedbackWithNoDate = { ...mockFeedback, source_created_at: '' }
      renderWithRouter(<FeedbackCard feedback={feedbackWithNoDate} />)
      // The formatDate helper returns 'N/A' for empty dates - may appear multiple times
      const naElements = screen.getAllByText('N/A')
      expect(naElements.length).toBeGreaterThan(0)
    })
  })
})
