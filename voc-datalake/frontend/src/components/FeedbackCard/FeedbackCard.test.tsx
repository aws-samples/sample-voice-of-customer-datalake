/**
 * @fileoverview Tests for FeedbackCard component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import i18n from 'i18next'
import { screen } from '@testing-library/react'
import { render } from '../../test/test-utils'
import FeedbackCard from './FeedbackCard'
import type { FeedbackItem } from '../../api/types'

// Router + QueryClient (the card reads the configured category / source names).
function renderWithRouter(ui: React.ReactElement, initialEntries: string[] = ['/']) {
  return render(ui, { initialEntries })
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
      const { container } = renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('Web scraper')).toBeInTheDocument()
      expect(container.querySelector('svg.lucide-globe')).not.toBeNull()
      expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u)
    })

    it('renders sentiment as a word and a percent, not the raw score', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('Positive · 92%')).toBeInTheDocument()
      expect(screen.queryByText(/0\.92/)).not.toBeInTheDocument()
    })

    it('shows scraped text without markdown escapes', () => {
      renderWithRouter(<FeedbackCard feedback={{ ...mockFeedback, original_text: '**Fast** delivery\\.' }} />)
      expect(screen.getByText('Fast delivery.')).toBeInTheDocument()
    })

    it('renders category badge as a label, never the stored id', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('Product quality')).toBeInTheDocument()
    })

    // Labels vs status (design system rule 15): the category is the one accent
    // label; subcategory, journey stage and persona are neutral, never info/aim.
    it('emphasises only the category among the descriptive labels', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText('Product quality')).toHaveClass('badge', 'badge-accent')
      expect(screen.getByText('Features')).toHaveClass('badge', 'badge-muted')
      expect(screen.getByText('Post purchase')).toHaveClass('badge', 'badge-muted')
      expect(screen.getByText('Happy Customer')).toHaveClass('badge', 'badge-muted')
    })

    it('never tints a descriptive label with a status tone', () => {
      const { container } = renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(container.querySelectorAll('.badge-info, .badge-aim')).toHaveLength(0)
      expect(container.querySelectorAll('.badge-accent')).toHaveLength(1)
    })

    it('renders formatted date', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByText(/Jan 15, 2025/)).toBeInTheDocument()
    })

    // verify5/V6 item 3: the review date was English ("Oct 19, 2026") under de.
    it('writes the date in the UI language', async () => {
      await i18n.changeLanguage('de')
      try {
        renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
        expect(screen.getByText('15.01.2025')).toBeInTheDocument()
      } finally {
        await i18n.changeLanguage('en')
      }
    })
  })

  describe('journey stage', () => {
    it('shows no "Unknown" chip for a journey stage the model could not tell', () => {
      renderWithRouter(<FeedbackCard feedback={{ ...mockFeedback, journey_stage: 'unknown' }} />)
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument()
    })
  })

  describe('rating display', () => {
    it('renders star rating when provided', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      // Should have 5 star icons
      const stars = document.querySelectorAll('.text-warn')
      expect(stars).toHaveLength(5)
    })

    it('does not render rating when not provided', () => {
      const feedbackWithoutRating = { ...mockFeedback, rating: undefined }
      renderWithRouter(<FeedbackCard feedback={feedbackWithoutRating} />)
      const stars = document.querySelectorAll('.text-warn')
      expect(stars).toHaveLength(0)
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
      const { container } = renderWithRouter(<FeedbackCard feedback={urgentFeedback} />)
      expect(container.querySelector('.border-l-warn')).toBeInTheDocument()
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

    // verify5/V6: at 390 px / 200 % text a long word in the issue pushed the card to 443 px.
    it('lets the footer actions wrap instead of pushing the card wider', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      const actions = screen.getByTestId('feedback-card-actions')
      expect(actions).toHaveClass('flex-wrap', 'min-w-0')
      expect(actions).not.toHaveClass('flex-shrink-0')
    })

    it('lets long words in the issue break inside the card', () => {
      renderWithRouter(<FeedbackCard feedback={{ ...mockFeedback, problem_summary: 'Unprofessionalism' }} />)
      expect(screen.getByTestId('feedback-issue')).toHaveClass('min-w-0', '[overflow-wrap:break-word]', 'hyphens-auto')
    })
  })

  describe('actions', () => {
    it('renders the Details link', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByRole('link', { name: /details/i })).toBeInTheDocument()
    })

    it('renders external link when source_url is provided', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      const externalLink = document.querySelector('a[target="_blank"]')
      expect(externalLink).toHaveAttribute('href', 'https://example.com/review/123')
    })

    it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', '/feedback/1'])(
      'renders no external link when source_url is not an http(s) URL (%s)',
      (sourceUrl) => {
        renderWithRouter(<FeedbackCard feedback={{ ...mockFeedback, source_url: sourceUrl }} />)
        expect(document.querySelector('a[target="_blank"]')).toBeNull()
      },
    )

    it('renders copy button', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />)
      expect(screen.getByTitle('Copy text')).toBeInTheDocument()
    })
  })

  describe('compact mode', () => {
    it('renders compact card as a review-modal link on the current page', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} compact={true} />, ['/categories?category=delivery'])
      // Compact mode renders as a link
      const link = screen.getByRole('link')
      expect(link).toHaveAttribute('href', '/categories?category=delivery&review=fb-123')
    })

    it('opens the review modal from the Details action of the full card', () => {
      renderWithRouter(<FeedbackCard feedback={mockFeedback} />, ['/dashboard'])
      expect(screen.getByRole('link', { name: /details/i })).toHaveAttribute('href', '/dashboard?review=fb-123')
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
      const { container } = renderWithRouter(<FeedbackCard feedback={webscraperFeedback} />)
      expect(screen.getByText('Web Scraper')).toBeInTheDocument()
      expect(container.querySelector('svg.lucide-globe')).not.toBeNull()
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
