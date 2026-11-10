/**
 * The Dashboard says IN TEXT when its counts cover only part of the window
 * (5.34.00 live finding: "Review date" + "All time" showed "~297" against
 * 17,067 on "Imported date", explained only by a hover title).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MetricsSummary } from '../../api/types'
import PartialCountsNote from './PartialCountsNote'
import enDashboard from '../../../public/locales/en/dashboard.json'
import enCommon from '../../../public/locales/en/common.json'

const base: MetricsSummary = {
  period_days: 0, total_feedback: 297, avg_sentiment: 0, urgent_count: 3, daily_totals: [], daily_sentiment: [],
}

describe('PartialCountsNote', () => {
  it('shows a visible status naming the covered range and why when a review-date window was cut short', () => {
    render(<PartialCountsNote summary={{ ...base, is_partial: true, partial_reason: 'time_budget', scanned_through: '2026-09-01' }} dateBasis="review" />)
    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('2026-09-01')
    expect(note).toHaveTextContent(enDashboard.partialNote.reviewBasis)
  })

  it('still explains an imported-date partial window, without the review-date reason', () => {
    render(<PartialCountsNote summary={{ ...base, is_partial: true }} dateBasis="imported" />)
    const note = screen.getByRole('status')
    expect(note).toHaveTextContent(enCommon.partialCountsHint)
    expect(note).not.toHaveTextContent(enDashboard.partialNote.reviewBasis)
  })

  it('shows nothing when the window was read in full', () => {
    render(<PartialCountsNote summary={{ ...base, is_partial: false }} dateBasis="review" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
