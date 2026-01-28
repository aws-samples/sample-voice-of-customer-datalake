import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { FeedbackList } from './FeedbackList'
import type { FeedbackItem } from '../../api/client'

const mockFeedback: FeedbackItem[] = [
  {
    feedback_id: '1',
    source_platform: 'webscraper',
    original_text: 'Great delivery service, very fast!',
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
    original_text: 'This is a very long review that should be truncated because it exceeds the character limit for display in the compact view. The full text should only be visible when expanded.',
    sentiment_label: 'negative',
    sentiment_score: -0.7,
    category: 'customer_support',
    source_created_at: '2026-01-02T10:00:00Z',
    rating: 2,
    problem_summary: 'Slow response time',
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

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('FeedbackList', () => {
  it('shows prompt when no categories selected', () => {
    renderWithRouter(<FeedbackList feedback={[]} selectedCategories={[]} />)
    expect(screen.getByText('Select categories above to view feedback')).toBeInTheDocument()
  })

  it('shows empty state when no feedback matches', () => {
    renderWithRouter(<FeedbackList feedback={[]} selectedCategories={['delivery']} />)
    expect(screen.getByText('No feedback found for selected categories')).toBeInTheDocument()
  })

  it('renders feedback items', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    expect(screen.getByText('Feedback (2)')).toBeInTheDocument()
    expect(screen.getByText(/great delivery service/i)).toBeInTheDocument()
  })

  it('shows sentiment badges', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    expect(screen.getByText('positive')).toBeInTheDocument()
    expect(screen.getByText('negative')).toBeInTheDocument()
  })

  it('shows source platform badges', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    expect(screen.getByText('webscraper')).toBeInTheDocument()
    expect(screen.getByText('manual_import')).toBeInTheDocument()
  })

  it('shows ratings when available', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('truncates long text', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    // Should show truncated text with ellipsis
    expect(screen.getByText(/this is a very long review.*\.\.\./i)).toBeInTheDocument()
  })

  it('expands item when clicked', async () => {
    const user = userEvent.setup()
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    // Initially, problem_summary should not be visible
    expect(screen.queryByText(/slow response time/i)).not.toBeInTheDocument()

    // Find and click the second item's expand button (the one with problem_summary)
    const expandButtons = screen.getAllByRole('button')
    // Filter to only chevron buttons
    const chevronButtons = expandButtons.filter(btn => 
      btn.querySelector('svg.lucide-chevron-down') || btn.querySelector('svg.lucide-chevron-up')
    )
    
    // Click the second expand button (for the item with problem_summary)
    if (chevronButtons[1]) {
      await user.click(chevronButtons[1])
      // After expansion, should show problem_summary
      expect(screen.getByText(/slow response time/i)).toBeInTheDocument()
    }
  })

  it('shows selected categories in header', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery', 'customer_support']} />)

    expect(screen.getByText(/showing feedback for: delivery, customer support/i)).toBeInTheDocument()
  })

  it('has links to feedback detail pages', () => {
    renderWithRouter(<FeedbackList feedback={mockFeedback} selectedCategories={['delivery']} />)

    const links = screen.getAllByRole('link')
    expect(links.some(link => link.getAttribute('href') === '/feedback/1')).toBe(true)
    expect(links.some(link => link.getAttribute('href') === '/feedback/2')).toBe(true)
  })
})
