/**
 * @fileoverview Tests for ProblemRow component
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ProblemRow } from './ProblemRow'

const mockProblemGroup = {
  problem: 'Slow delivery times',
  similarProblems: ['Delivery too slow', 'Shipping delays'],
  rootCause: 'Logistics bottleneck in warehouse',
  items: [
    {
      feedback_id: 'f1',
      source_platform: 'twitter',
      brand_name: 'TestBrand',
      original_text: 'The delivery was very slow',
      category: 'delivery',
      subcategory: 'shipping_speed',
      problem_summary: 'Slow delivery times',
      sentiment_score: -0.5,
      sentiment_label: 'negative' as const,
      urgency: 'high' as const,
      source_created_at: '2025-01-01',
      processed_at: '2025-01-01',
      original_language: 'en',
      source_id: 's1',
      source_channel: 'social',
      journey_stage: 'post_purchase',
      impact_area: 'delivery',
    },
    {
      feedback_id: 'f2',
      source_platform: 'trustpilot',
      brand_name: 'TestBrand',
      original_text: 'Shipping took forever',
      category: 'delivery',
      subcategory: 'shipping_speed',
      problem_summary: 'Delivery too slow',
      sentiment_score: -0.6,
      sentiment_label: 'negative' as const,
      urgency: 'medium' as const,
      source_created_at: '2025-01-02',
      processed_at: '2025-01-02',
      original_language: 'en',
      source_id: 's2',
      source_channel: 'review',
      journey_stage: 'post_purchase',
      impact_area: 'delivery',
    },
  ],
  avgSentiment: -0.55,
  urgentCount: 1,
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('ProblemRow', () => {
  describe('collapsed state', () => {
    it('renders problem summary', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText('Slow delivery times')).toBeInTheDocument()
    })

    it('shows similar problems count badge', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText('+2')).toBeInTheDocument()
    })

    it('shows root cause hypothesis', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText(/logistics bottleneck/i)).toBeInTheDocument()
    })

    it('shows item count', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('shows urgent count badge', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('shows sentiment badge', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText('negative')).toBeInTheDocument()
    })
  })

  describe('expanded state', () => {
    it('shows feedback items when expanded', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText('The delivery was very slow')).toBeInTheDocument()
      expect(screen.getByText('Shipping took forever')).toBeInTheDocument()
    })

    it('shows similar problems list when expanded', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )

      expect(screen.getByText(/similar:/i)).toBeInTheDocument()
    })

    it('feedback items link to detail page', () => {
      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={true}
          onToggle={vi.fn()}
        />
      )

      const links = screen.getAllByRole('link')
      expect(links[0]).toHaveAttribute('href', '/feedback/f1')
    })
  })

  describe('interactions', () => {
    it('calls onToggle when clicked', async () => {
      const onToggle = vi.fn()
      const user = userEvent.setup()

      renderWithRouter(
        <ProblemRow
          problemGroup={mockProblemGroup}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={onToggle}
        />
      )

      await user.click(screen.getByText('Slow delivery times'))
      expect(onToggle).toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('handles problem with no similar problems', () => {
      const groupNoSimilar = { ...mockProblemGroup, similarProblems: [] }

      renderWithRouter(
        <ProblemRow
          problemGroup={groupNoSimilar}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument()
    })

    it('handles problem with no root cause', () => {
      const groupNoRootCause = { ...mockProblemGroup, rootCause: null }

      renderWithRouter(
        <ProblemRow
          problemGroup={groupNoRootCause}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      expect(screen.queryByText(/logistics/i)).not.toBeInTheDocument()
    })

    it('handles problem with no urgent items', () => {
      const groupNoUrgent = { ...mockProblemGroup, urgentCount: 0 }

      renderWithRouter(
        <ProblemRow
          problemGroup={groupNoUrgent}
          problemKey="delivery:shipping:slow"
          isExpanded={false}
          onToggle={vi.fn()}
        />
      )

      // Should not show urgent badge (only the item count "2" should be visible)
      const badges = screen.getAllByText('2')
      expect(badges).toHaveLength(1)
    })
  })
})
