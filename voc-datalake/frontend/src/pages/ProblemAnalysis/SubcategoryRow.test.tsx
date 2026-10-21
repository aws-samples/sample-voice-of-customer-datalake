/**
 * @fileoverview Tests for SubcategoryRow component.
 *
 * Problem rows fetch their feedback on demand via `useProblemItems`; that hook
 * is mocked so the one expansion assertion here can see example rows without a
 * QueryClient. The mock returns a fixed row keyed by nothing in particular —
 * these tests exercise the subcategory's wiring, not the drill-down itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SubcategoryRow } from './SubcategoryRow'
import { buildResolutionKey } from './problemResolution'
import type { ProblemItems } from './useProblemItems'
import type { FeedbackItem } from '../../api/client'

const drillRow: FeedbackItem = {
  feedback_id: 'f1',
  source_platform: 'webscraper',
  brand_name: 'TestBrand',
  original_text: 'Delivery was slow',
  category: 'delivery',
  subcategory: 'shipping_speed',
  problem_summary: 'Slow delivery times',
  sentiment_score: -0.5,
  sentiment_label: 'negative',
  urgency: 'high',
  source_created_at: '2025-01-01',
  processed_at: '2025-01-01',
  original_language: 'en',
  source_id: 's1',
  source_channel: 'social',
  journey_stage: 'post_purchase',
  impact_area: 'delivery',
}

const mockUseProblemItems = vi.fn<() => ProblemItems>()
vi.mock('./useProblemItems', () => ({
  useProblemItems: () => mockUseProblemItems(),
}))

const drillParams = { dateParams: { days: 7 }, source: null, customFilters: {} }

const mockSubcategoryGroup = {
  subcategory: 'shipping_speed',
  problems: [
    {
      problem: 'Slow delivery times',
      similarProblems: [],
      rootCause: 'Logistics issues',
      itemCount: 1,
      avgSentiment: -0.5,
      urgentCount: 1,
    },
    {
      problem: 'Package damaged',
      similarProblems: [],
      rootCause: null,
      itemCount: 1,
      avgSentiment: -0.7,
      urgentCount: 0,
    },
  ],
  totalItems: 2,
  urgentCount: 1,
}

function renderRow(
  overrides: Partial<React.ComponentProps<typeof SubcategoryRow>> = {},
) {
  const props: React.ComponentProps<typeof SubcategoryRow> = {
    categoryName: 'delivery',
    subcategoryGroup: mockSubcategoryGroup,
    isExpanded: false,
    onToggle: vi.fn(),
    expandedProblems: new Set(),
    onToggleProblem: vi.fn(),
    onToggleResolved: vi.fn(),
    drillParams,
    ...overrides,
  }
  return render(<MemoryRouter><SubcategoryRow {...props} /></MemoryRouter>)
}

beforeEach(() => {
  mockUseProblemItems.mockReset()
  mockUseProblemItems.mockReturnValue({ items: [drillRow], isLoading: false, isError: false })
})

describe('SubcategoryRow', () => {
  describe('collapsed state', () => {
    it('renders subcategory name', () => {
      renderRow()
      expect(screen.getByText('shipping speed')).toBeInTheDocument()
    })

    it('shows problem and review counts', () => {
      renderRow()
      expect(screen.getByText(/2 problems/)).toBeInTheDocument()
      expect(screen.getByText(/2 reviews/)).toBeInTheDocument()
    })

    it('shows urgent count badge when has urgent items', () => {
      renderRow()
      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('does not show urgent badge when no urgent items', () => {
      renderRow({ subcategoryGroup: { ...mockSubcategoryGroup, urgentCount: 0 } })
      // Only the counts in the text should be visible
      expect(screen.queryByText('0')).not.toBeInTheDocument()
    })
  })

  describe('expanded state', () => {
    it('shows problem rows when expanded', () => {
      renderRow({ isExpanded: true })
      expect(screen.getByText('Slow delivery times')).toBeInTheDocument()
      expect(screen.getByText('Package damaged')).toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('calls onToggle when header clicked', async () => {
      const onToggle = vi.fn()
      const user = userEvent.setup()
      renderRow({ onToggle })

      await user.click(screen.getByText('shipping speed'))
      expect(onToggle).toHaveBeenCalled()
    })

    it('calls onToggleProblem when problem row clicked', async () => {
      const onToggleProblem = vi.fn()
      const user = userEvent.setup()
      renderRow({ isExpanded: true, onToggleProblem })

      await user.click(screen.getByText('Slow delivery times'))
      expect(onToggleProblem).toHaveBeenCalledWith('delivery:shipping_speed:Slow delivery times')
    })
  })

  describe('problem expansion', () => {
    it('expands problem when in expandedProblems set', () => {
      const expandedProblems = new Set(['delivery:shipping_speed:Slow delivery times'])
      renderRow({ isExpanded: true, expandedProblems })

      // When a problem is expanded, its on-demand feedback rows are visible.
      expect(screen.getByText('Delivery was slow')).toBeInTheDocument()
    })
  })

  describe('per-key pending (issue #159)', () => {
    it('disables only the resolve button whose key is pending', () => {
      renderRow({
        isExpanded: true,
        pendingKeys: new Set([buildResolutionKey('delivery', 'shipping_speed', 'Slow delivery times')]),
      })

      const [slowDeliveryButton, damagedButton] = screen.getAllByRole('button', { name: /resolved/i })
      expect(slowDeliveryButton).toBeDisabled()
      expect(damagedButton).not.toBeDisabled()
    })
  })
})
