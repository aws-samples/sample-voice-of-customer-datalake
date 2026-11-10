/**
 * @fileoverview Tests for SubcategoryRow component
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { clientApiModule, feedbackById, problemAnalysisApiMocks, SHIPPING_SPEED_SUBCATEGORY } from './problem-analysis-fixtures'
import { renderSubcategoryRow } from './problem-row-fixtures'
import { buildResolutionKey } from './problemResolution'

vi.mock('../../api/client', () => clientApiModule())

describe('SubcategoryRow', () => {
  describe('collapsed state', () => {
    it('renders subcategory name', () => {
      renderSubcategoryRow()

      expect(screen.getByText('Shipping speed')).toBeInTheDocument()
    })

    it('shows problem and review counts', () => {
      renderSubcategoryRow()

      expect(screen.getByText(/2 problems/)).toBeInTheDocument()
      expect(screen.getByText(/2 reviews/)).toBeInTheDocument()
    })

    it('shows urgent count badge when has urgent items', () => {
      renderSubcategoryRow()

      expect(screen.getByText('1 urgent')).toBeInTheDocument()
    })

    it('does not show urgent badge when no urgent items', () => {
      renderSubcategoryRow({ subcategoryGroup: { ...SHIPPING_SPEED_SUBCATEGORY, urgentCount: 0 } })

      // Only the counts in the text should be visible
      expect(screen.queryByText('0')).not.toBeInTheDocument()
    })
  })

  describe('expanded state', () => {
    it('shows problem rows when expanded', () => {
      renderSubcategoryRow({ isExpanded: true })

      expect(screen.getByText('Slow delivery times')).toBeInTheDocument()
      expect(screen.getByText('Package damaged')).toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('calls onToggle when header clicked', async () => {
      const onToggle = vi.fn()
      const user = userEvent.setup()

      renderSubcategoryRow({ onToggle })

      await user.click(screen.getByText('Shipping speed'))
      expect(onToggle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    })

    it('calls onToggleProblem when problem row clicked', async () => {
      const onToggleProblem = vi.fn()
      const user = userEvent.setup()

      renderSubcategoryRow({ isExpanded: true, onToggleProblem })

      await user.click(screen.getByText('Slow delivery times'))
      expect(onToggleProblem).toHaveBeenCalledWith('delivery:shipping_speed:Slow delivery times')
    })
  })

  describe('problem expansion', () => {
    it('expands problem when in expandedProblems set', async () => {
      problemAnalysisApiMocks.getFeedbackById.mockImplementation(feedbackById)
      const expandedProblems = new Set(['delivery:shipping_speed:Slow delivery times'])

      renderSubcategoryRow({ isExpanded: true, expandedProblems })

      // When problem is expanded, its example reviews are read and shown
      expect(await screen.findByText('The delivery was very slow')).toBeInTheDocument()
    })

    it('counts every problem the server found, not only the listed ones', () => {
      renderSubcategoryRow({ subcategoryGroup: { ...SHIPPING_SPEED_SUBCATEGORY, problemCount: 40 } })

      expect(screen.getByText(/40 problems/)).toBeInTheDocument()
    })
  })

  describe('per-key pending (issue #159)', () => {
    it('disables only the resolve button whose key is pending', () => {
      renderSubcategoryRow({
        isExpanded: true,
        pendingKeys: new Set([buildResolutionKey('delivery', 'shipping_speed', 'Slow delivery times')]),
      })

      const [slowDeliveryButton, damagedButton] = screen.getAllByRole('button', { name: /resolved/i })
      expect(slowDeliveryButton).toBeDisabled()
      expect(damagedButton).not.toBeDisabled()
    })
  })
})
