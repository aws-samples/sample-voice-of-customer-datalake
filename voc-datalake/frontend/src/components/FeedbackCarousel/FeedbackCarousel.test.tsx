/**
 * @fileoverview Tests for FeedbackCarousel component.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import FeedbackCarousel from './FeedbackCarousel'
import type { FeedbackItem } from '../../api/client'

// Helper to render with router
function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {ui}
    </MemoryRouter>
  )
}

const createMockFeedback = (id: string, overrides?: Partial<FeedbackItem>): FeedbackItem => ({
  feedback_id: id,
  source_id: `src-${id}`,
  source_platform: 'webscraper',
  source_channel: 'reviews',
  brand_name: 'TestBrand',
  source_created_at: '2025-01-15T10:30:00Z',
  processed_at: '2025-01-15T10:35:00Z',
  original_text: `Feedback text for ${id}`,
  original_language: 'en',
  category: 'product_quality',
  journey_stage: 'post_purchase',
  sentiment_label: 'positive',
  sentiment_score: 0.85,
  urgency: 'low',
  impact_area: 'product',
  ...overrides,
})

describe('FeedbackCarousel', () => {
  describe('empty state', () => {
    it('returns null when items array is empty', () => {
      const { container } = renderWithRouter(<FeedbackCarousel items={[]} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('basic rendering', () => {
    it('renders feedback items', () => {
      const items = [createMockFeedback('1'), createMockFeedback('2')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText('Feedback text for 1')).toBeInTheDocument()
      expect(screen.getByText('Feedback text for 2')).toBeInTheDocument()
    })

    it('renders title when provided', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} title="Related feedback:" />)
      
      expect(screen.getByText('Related feedback:')).toBeInTheDocument()
    })

    it('does not render title when not provided', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.queryByText('Related feedback:')).not.toBeInTheDocument()
    })
  })

  describe('feedback card content', () => {
    it('displays source platform with icon', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      // Component capitalizes the source name via CSS (capitalize class)
      expect(screen.getByText('webscraper')).toBeInTheDocument()
      expect(screen.getByText('🌐')).toBeInTheDocument()
    })

    it('displays sentiment badge', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText('positive')).toBeInTheDocument()
    })

    it('displays category badge', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText('product_quality')).toBeInTheDocument()
    })

    it('displays rating stars when provided', () => {
      const items = [createMockFeedback('1', { rating: 4 })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      const filledStars = document.querySelectorAll('.text-yellow-400.fill-yellow-400')
      expect(filledStars.length).toBe(4)
    })

    it('displays View Details link', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      const link = screen.getByRole('link', { name: 'View Details' })
      expect(link).toHaveAttribute('href', '/feedback/1')
    })
  })

  describe('urgency indicator', () => {
    it('shows urgent badge for high urgency items', () => {
      const items = [createMockFeedback('1', { urgency: 'high' })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText('Urgent')).toBeInTheDocument()
    })

    it('applies urgent border styling', () => {
      const items = [createMockFeedback('1', { urgency: 'high' })]
      const { container } = renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(container.querySelector('.border-l-orange-500')).toBeInTheDocument()
    })
  })

  describe('problem summary', () => {
    it('displays problem summary when provided', () => {
      const items = [createMockFeedback('1', { problem_summary: 'Shipping delay' })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText(/Issue: Shipping delay/)).toBeInTheDocument()
    })
  })

  describe('external link', () => {
    it('renders external link when source_url is provided', () => {
      const items = [createMockFeedback('1', { source_url: 'https://example.com/review' })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      const externalLink = document.querySelector('a[target="_blank"]')
      expect(externalLink).toHaveAttribute('href', 'https://example.com/review')
    })

    it('does not render external link when source_url is not provided', () => {
      const items = [createMockFeedback('1', { source_url: undefined })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      const externalLinks = document.querySelectorAll('a[target="_blank"]')
      expect(externalLinks.length).toBe(0)
    })
  })

  describe('source formatting', () => {
    it('formats web_scrape source as Web Scraper', () => {
      const items = [createMockFeedback('1', { source_platform: 'web_scrape' })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText('Web Scraper')).toBeInTheDocument()
    })

    it('formats webscraper source correctly', () => {
      const items = [createMockFeedback('1', { source_platform: 'webscraper' })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      // Component capitalizes the source name via CSS (capitalize class)
      expect(screen.getByText('webscraper')).toBeInTheDocument()
      expect(screen.getByText('🌐')).toBeInTheDocument()
    })
  })

  describe('date formatting', () => {
    it('formats date correctly', () => {
      const items = [createMockFeedback('1')]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText(/Jan 15/)).toBeInTheDocument()
    })

    it('handles invalid date gracefully', () => {
      const items = [createMockFeedback('1', { source_created_at: 'invalid' })]
      renderWithRouter(<FeedbackCarousel items={items} />)
      
      expect(screen.getByText('N/A')).toBeInTheDocument()
    })
  })
})
