/**
 * @fileoverview Tests for ProblemRow component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { clientApiModule, feedbackById, makeProblemGroup, problemAnalysisApiMocks } from './problem-analysis-fixtures'
import { renderProblemRow } from './problem-row-fixtures'

vi.mock('../../api/client', () => clientApiModule())

beforeEach(() => {
  problemAnalysisApiMocks.getFeedbackById.mockReset()
  problemAnalysisApiMocks.getFeedbackById.mockImplementation(feedbackById)
})

describe('ProblemRow', () => {
  describe('collapsed state', () => {
    it.each<[outcome: string, overrides: Parameters<typeof renderProblemRow>[0], text: string]>([
      ['renders problem summary', {}, 'Slow delivery times'],
      ['shows similar problems count badge', {}, '+2 similar'],
      [
        'counts every merged wording, not only the ones the server listed',
        { problemGroup: makeProblemGroup({ similarCount: 25 }) },
        '+25 similar',
      ],
    ])('%s', (_outcome, overrides, text) => {
      renderProblemRow(overrides)

      expect(screen.getByText(text)).toBeInTheDocument()
    })

    // Labels vs status (design system rule 15): a count is a label, so it is
    // neutral; only the urgent count carries a state tone.
    it('tones the similar count neutral and the urgent count warn', () => {
      renderProblemRow()

      expect(screen.getByText('+2 similar')).toHaveClass('badge', 'badge-muted')
      expect(screen.getByText('1 urgent')).toHaveClass('badge', 'badge-warn')
    })

    it('shows root cause hypothesis', () => {
      renderProblemRow()

      expect(screen.getByText(/logistics bottleneck/i)).toBeInTheDocument()
    })

    it('shows the review count with its unit, not a bare number', () => {
      renderProblemRow()

      expect(screen.getByText('2 reviews')).toBeInTheDocument()
      expect(screen.queryByText('2')).not.toBeInTheDocument()
    })

    it('shows the urgent count with its unit', () => {
      renderProblemRow()

      expect(screen.getByText('1 urgent')).toBeInTheDocument()
    })

    it('says the sentiment in words with the share, keeping the average as the number', () => {
      renderProblemRow()

      expect(screen.getByText(/negative · \d+% negative/)).toBeInTheDocument()
    })

    it('labels the resolve action with text, not only an icon', () => {
      renderProblemRow()

      expect(screen.getByRole('button', { name: 'Mark as resolved' })).toHaveTextContent('Mark as resolved')
    })
  })

  describe('expanded state', () => {
    it('reads its example reviews by id when expanded, and says how many it has in all', async () => {
      renderProblemRow({ isExpanded: true, problemGroup: makeProblemGroup({ count: 40 }) })

      expect(await screen.findByText('The delivery was very slow')).toBeInTheDocument()
      expect(await screen.findByText('Shipping took forever')).toBeInTheDocument()
      expect(screen.getByText('Showing 2 of 40 reviews')).toBeInTheDocument()
      expect(problemAnalysisApiMocks.getFeedbackById.mock.calls.map(([id]) => id)).toStrictEqual(['f1', 'f2'])
    })

    it('reads nothing while collapsed', () => {
      renderProblemRow()

      expect(problemAnalysisApiMocks.getFeedbackById).not.toHaveBeenCalled()
    })

    it('says so when no example could be read', async () => {
      renderProblemRow({ isExpanded: true, problemGroup: makeProblemGroup({ sampleIds: ['gone'] }) })

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the example reviews.')
    })

    it('shows similar problems list when expanded', () => {
      renderProblemRow({ isExpanded: true })

      expect(screen.getByText(/similar:/i)).toBeInTheDocument()
    })

    it('feedback items open the review modal on this page', async () => {
      renderProblemRow({ isExpanded: true })

      const links = await screen.findAllByRole('link')
      expect(links[0]).toHaveAttribute('href', '/?review=f1')
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
      renderProblemRow({ problemGroup: makeProblemGroup({ similarProblems: [], similarCount: 0 }) })

      expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument()
    })

    it('handles problem with no root cause', () => {
      renderProblemRow({ problemGroup: makeProblemGroup({ rootCause: null }) })

      expect(screen.queryByText(/logistics/i)).not.toBeInTheDocument()
    })

    it('handles problem with no urgent items', () => {
      renderProblemRow({ problemGroup: makeProblemGroup({ urgentCount: 0 }) })

      expect(screen.queryByText(/urgent/)).not.toBeInTheDocument()
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
