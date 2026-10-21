/**
 * @fileoverview Tests for ProblemRow component.
 *
 * The row now carries counts, not rows: the feedback behind an expanded
 * problem is fetched on demand by `useProblemItems`. That hook is mocked here
 * so these tests exercise the row's rendering of whatever the drill-down
 * returns, without a QueryClient or network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ProblemRow } from './ProblemRow'
import type { ProblemItems } from './useProblemItems'
import type { FeedbackItem } from '../../api/client'

const mockUseProblemItems = vi.fn<() => ProblemItems>()
vi.mock('./useProblemItems', () => ({
  useProblemItems: () => mockUseProblemItems(),
}))

const drillItems: FeedbackItem[] = [
  {
    feedback_id: 'f1',
    source_platform: 'webscraper',
    brand_name: 'TestBrand',
    original_text: 'The delivery was very slow',
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
  },
  {
    feedback_id: 'f2',
    source_platform: 'manual_import',
    brand_name: 'TestBrand',
    original_text: 'Shipping took forever',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Delivery too slow',
    sentiment_score: -0.6,
    sentiment_label: 'negative',
    urgency: 'medium',
    source_created_at: '2025-01-02',
    processed_at: '2025-01-02',
    original_language: 'en',
    source_id: 's2',
    source_channel: 'review',
    journey_stage: 'post_purchase',
    impact_area: 'delivery',
  },
]

const mockProblemGroup = {
  problem: 'Slow delivery times',
  similarProblems: ['Delivery too slow', 'Shipping delays'],
  rootCause: 'Logistics bottleneck in warehouse',
  itemCount: 2,
  avgSentiment: -0.55,
  urgentCount: 1,
}

const drillParams = {
  dateParams: { days: 7 },
  source: null,
  customFilters: {},
}

function renderRow(
  overrides: Partial<React.ComponentProps<typeof ProblemRow>> = {},
) {
  const props: React.ComponentProps<typeof ProblemRow> = {
    problemGroup: mockProblemGroup,
    problemKey: 'delivery:shipping:slow',
    categoryName: 'delivery',
    subcategoryName: 'shipping_speed',
    drillParams,
    isExpanded: false,
    onToggle: vi.fn(),
    onToggleResolved: vi.fn(),
    ...overrides,
  }
  return render(<MemoryRouter><ProblemRow {...props} /></MemoryRouter>)
}

beforeEach(() => {
  mockUseProblemItems.mockReset()
  mockUseProblemItems.mockReturnValue({ items: drillItems, isLoading: false, isError: false })
})

describe('ProblemRow', () => {
  describe('collapsed state', () => {
    it('renders problem summary', () => {
      renderRow()
      expect(screen.getByText('Slow delivery times')).toBeInTheDocument()
    })

    it('shows similar problems count badge', () => {
      renderRow()
      expect(screen.getByText('+2')).toBeInTheDocument()
    })

    it('shows root cause hypothesis', () => {
      renderRow()
      expect(screen.getByText(/logistics bottleneck/i)).toBeInTheDocument()
    })

    it('shows item count', () => {
      renderRow()
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('shows urgent count badge', () => {
      renderRow()
      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('shows sentiment badge', () => {
      renderRow()
      expect(screen.getByText('negative')).toBeInTheDocument()
    })
  })

  describe('expanded state', () => {
    it('shows feedback items from the drill-down when expanded', () => {
      renderRow({ isExpanded: true })

      expect(screen.getByText('The delivery was very slow')).toBeInTheDocument()
      expect(screen.getByText('Shipping took forever')).toBeInTheDocument()
    })

    it('shows a spinner while the drill-down loads', () => {
      mockUseProblemItems.mockReturnValue({ items: [], isLoading: true, isError: false })
      renderRow({ isExpanded: true })

      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })

    it('shows an error line when the drill-down fails', () => {
      mockUseProblemItems.mockReturnValue({ items: [], isLoading: false, isError: true })
      renderRow({ isExpanded: true })

      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    it('shows an empty message when no example rows come back', () => {
      mockUseProblemItems.mockReturnValue({ items: [], isLoading: false, isError: false })
      renderRow({ isExpanded: true })

      expect(screen.getByText('No example feedback found.')).toBeInTheDocument()
    })

    it('shows similar problems list when expanded', () => {
      renderRow({ isExpanded: true })
      expect(screen.getByText(/similar:/i)).toBeInTheDocument()
    })

    it('feedback items link to detail page', () => {
      renderRow({ isExpanded: true })
      const links = screen.getAllByRole('link')
      expect(links[0]).toHaveAttribute('href', '/feedback/f1')
    })
  })

  describe('interactions', () => {
    it('calls onToggle when clicked', async () => {
      const onToggle = vi.fn()
      const user = userEvent.setup()
      renderRow({ onToggle })

      await user.click(screen.getByText('Slow delivery times'))
      expect(onToggle).toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('handles problem with no similar problems', () => {
      renderRow({ problemGroup: { ...mockProblemGroup, similarProblems: [] } })
      expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument()
    })

    it('handles problem with no root cause', () => {
      renderRow({ problemGroup: { ...mockProblemGroup, rootCause: null } })
      expect(screen.queryByText(/logistics/i)).not.toBeInTheDocument()
    })

    it('handles problem with no urgent items', () => {
      renderRow({ problemGroup: { ...mockProblemGroup, urgentCount: 0 } })

      // Should not show urgent badge (only the item count "2" should be visible)
      const badges = screen.getAllByText('2')
      expect(badges).toHaveLength(1)
    })
  })
})


describe('problem resolution (issue #66)', () => {
  it('fires onToggleResolved from the resolve control without toggling the row', async () => {
    const onToggle = vi.fn()
    const onToggleResolved = vi.fn()
    renderRow({ onToggle, onToggleResolved })

    await userEvent.click(screen.getByRole('button', { name: /mark as resolved/i }))

    expect(onToggleResolved).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('shows the resolved badge and unresolve control for resolved groups', () => {
    renderRow({ problemGroup: { ...mockProblemGroup, resolved: true } })

    expect(screen.getByText('Resolved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /mark as unresolved/i })).toBeInTheDocument()
  })

  it('shows no resolved badge for unresolved groups', () => {
    renderRow()
    expect(screen.queryByText('Resolved')).not.toBeInTheDocument()
  })
})
