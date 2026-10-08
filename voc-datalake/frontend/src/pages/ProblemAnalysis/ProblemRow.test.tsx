/**
 * @fileoverview Tests for ProblemRow component
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeProblemGroup } from './problem-analysis-fixtures'
import { renderProblemRow } from './problem-row-fixtures'

describe('ProblemRow', () => {
  describe('collapsed state', () => {
    it('renders problem summary', () => {
      renderProblemRow()

      expect(screen.getByText('Slow delivery times')).toBeInTheDocument()
    })

    it('shows similar problems count badge', () => {
      renderProblemRow()

      expect(screen.getByText('+2')).toBeInTheDocument()
    })

    it('shows root cause hypothesis', () => {
      renderProblemRow()

      expect(screen.getByText(/logistics bottleneck/i)).toBeInTheDocument()
    })

    it('shows item count', () => {
      renderProblemRow()

      expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('shows urgent count badge', () => {
      renderProblemRow()

      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('shows sentiment badge', () => {
      renderProblemRow()

      expect(screen.getByText('negative')).toBeInTheDocument()
    })
  })

  describe('expanded state', () => {
    it('shows feedback items when expanded', () => {
      renderProblemRow({ isExpanded: true })

      expect(screen.getByText('The delivery was very slow')).toBeInTheDocument()
      expect(screen.getByText('Shipping took forever')).toBeInTheDocument()
    })

    it('shows similar problems list when expanded', () => {
      renderProblemRow({ isExpanded: true })

      expect(screen.getByText(/similar:/i)).toBeInTheDocument()
    })

    it('feedback items link to detail page', () => {
      renderProblemRow({ isExpanded: true })

      const links = screen.getAllByRole('link')
      expect(links[0]).toHaveAttribute('href', '/feedback/f1')
    })
  })

  describe('interactions', () => {
    it('calls onToggle when clicked', async () => {
      const onToggle = vi.fn()
      const user = userEvent.setup()

      renderProblemRow({ onToggle })

      await user.click(screen.getByText('Slow delivery times'))
      expect(onToggle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
    })
  })

  describe('edge cases', () => {
    it('handles problem with no similar problems', () => {
      renderProblemRow({ problemGroup: makeProblemGroup({ similarProblems: [] }) })

      expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument()
    })

    it('handles problem with no root cause', () => {
      renderProblemRow({ problemGroup: makeProblemGroup({ rootCause: null }) })

      expect(screen.queryByText(/logistics/i)).not.toBeInTheDocument()
    })

    it('handles problem with no urgent items', () => {
      renderProblemRow({ problemGroup: makeProblemGroup({ urgentCount: 0 }) })

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
    renderProblemRow({ onToggle, onToggleResolved })

    await userEvent.click(screen.getByRole('button', { name: /mark as resolved/i }))

    expect(onToggleResolved).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('shows the resolved badge and unresolve control for resolved groups', () => {
    renderProblemRow({ problemGroup: makeProblemGroup({ resolved: true }) })

    expect(screen.getByText('Resolved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /mark as unresolved/i })).toBeInTheDocument()
  })

  it('shows no resolved badge for unresolved groups', () => {
    renderProblemRow()

    expect(screen.queryByText('Resolved')).not.toBeInTheDocument()
  })
})
