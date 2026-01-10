/**
 * @fileoverview Tests for SubcategoryRow component
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SubcategoryRow } from './SubcategoryRow'

const mockSubcategoryGroup = {
  subcategory: 'shipping_speed',
  problems: [
    {
      problem: 'Slow delivery times',
      similarProblems: [],
      rootCause: 'Logistics issues',
      items: [
        {
          feedback_id: 'f1',
          source_platform: 'twitter',
          brand_name: 'TestBrand',
          original_text: 'Delivery was slow',
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
      ],
      avgSentiment: -0.5,
      urgentCount: 1,
    },
    {
      problem: 'Package damaged',
      similarProblems: [],
      rootCause: null,
      items: [
        {
          feedback_id: 'f2',
          source_platform: 'trustpilot',
          brand_name: 'TestBrand',
          original_text: 'Package arrived damaged',
          category: 'delivery',
          subcategory: 'shipping_speed',
          problem_summary: 'Package damaged',
          sentiment_score: -0.7,
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
      avgSentiment: -0.7,
      urgentCount: 0,
    },
  ],
  totalItems: 2,
  urgentCount: 1,
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('SubcategoryRow', () => {
  describe('collapsed state', () => {
    it('renders subcategory name', () => {
      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={false}
          onToggle={vi.fn()}
          expandedProblems={new Set()}
          onToggleProblem={vi.fn()}
        />
      )

      expect(screen.getByText('shipping speed')).toBeInTheDocument()
    })

    it('shows problem and review counts', () => {
      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={false}
          onToggle={vi.fn()}
          expandedProblems={new Set()}
          onToggleProblem={vi.fn()}
        />
      )

      expect(screen.getByText(/2 problems/)).toBeInTheDocument()
      expect(screen.getByText(/2 reviews/)).toBeInTheDocument()
    })

    it('shows urgent count badge when has urgent items', () => {
      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={false}
          onToggle={vi.fn()}
          expandedProblems={new Set()}
          onToggleProblem={vi.fn()}
        />
      )

      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('does not show urgent badge when no urgent items', () => {
      const groupNoUrgent = { ...mockSubcategoryGroup, urgentCount: 0 }

      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={groupNoUrgent}
          isExpanded={false}
          onToggle={vi.fn()}
          expandedProblems={new Set()}
          onToggleProblem={vi.fn()}
        />
      )

      // Only the counts in the text should be visible
      expect(screen.queryByText('0')).not.toBeInTheDocument()
    })
  })

  describe('expanded state', () => {
    it('shows problem rows when expanded', () => {
      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={true}
          onToggle={vi.fn()}
          expandedProblems={new Set()}
          onToggleProblem={vi.fn()}
        />
      )

      expect(screen.getByText('Slow delivery times')).toBeInTheDocument()
      expect(screen.getByText('Package damaged')).toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('calls onToggle when header clicked', async () => {
      const onToggle = vi.fn()
      const user = userEvent.setup()

      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={false}
          onToggle={onToggle}
          expandedProblems={new Set()}
          onToggleProblem={vi.fn()}
        />
      )

      await user.click(screen.getByText('shipping speed'))
      expect(onToggle).toHaveBeenCalled()
    })

    it('calls onToggleProblem when problem row clicked', async () => {
      const onToggleProblem = vi.fn()
      const user = userEvent.setup()

      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={true}
          onToggle={vi.fn()}
          expandedProblems={new Set()}
          onToggleProblem={onToggleProblem}
        />
      )

      await user.click(screen.getByText('Slow delivery times'))
      expect(onToggleProblem).toHaveBeenCalledWith('delivery:shipping_speed:Slow delivery times')
    })
  })

  describe('problem expansion', () => {
    it('expands problem when in expandedProblems set', () => {
      const expandedProblems = new Set(['delivery:shipping_speed:Slow delivery times'])

      renderWithRouter(
        <SubcategoryRow
          categoryName="delivery"
          subcategoryGroup={mockSubcategoryGroup}
          isExpanded={true}
          onToggle={vi.fn()}
          expandedProblems={expandedProblems}
          onToggleProblem={vi.fn()}
        />
      )

      // When problem is expanded, feedback items should be visible
      expect(screen.getByText('Delivery was slow')).toBeInTheDocument()
    })
  })
})
