/**
 * "Compared with us" verdicts: a row with too few of their reviews says so in neutral text instead
 * of a verdict, ONE footnote explains the threshold, and their lead is a heads-up (warn), never red.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import CompareTable from './CompareTable'
import { normalizeRadarPage } from '../../api/radarSchema'

const side = (volume: number, positive: number) => ({ volume, positive_share: positive, negative_share: 0.1 })

function renderRows(categories: unknown[], oursAvailable = true) {
  const { compare } = normalizeRadarPage({ compare: { ours_available: oursAvailable, categories } })
  renderWithQueryClient(<MemoryRouter><CompareTable compare={compare} onRead={vi.fn()} /></MemoryRouter>)
}

const rowOf = (category: string) => within(screen.getByRole('rowheader', { name: category }).closest('tr') ?? document.body)

describe('CompareTable verdicts', () => {
  it('says "Not enough reviews to compare" on a too-few row, with one footnote for the table', () => {
    renderRows([
      { category: 'delivery', theirs: side(3, 0.8), ours: side(40, 0.5), verdict: null, too_few: true },
      { category: 'pricing', theirs: side(2, 0.1), ours: side(40, 0.5), verdict: null, too_few: true },
    ])
    expect(rowOf('Delivery').getByText('Not enough reviews to compare')).toHaveClass('text-muted')
    expect(screen.getAllByTestId('compare-footnote')).toHaveLength(1)
    expect(screen.getByTestId('compare-footnote')).toHaveTextContent('at least 10 of their reviews')
  })

  it('tones their lead warn, never red, and ours ok', () => {
    renderRows([
      { category: 'delivery', theirs: side(30, 0.8), ours: side(40, 0.5), verdict: 'they_are_better', too_few: false },
      { category: 'support', theirs: side(30, 0.2), ours: side(40, 0.5), verdict: 'we_are_better', too_few: false },
    ])
    expect(rowOf('Delivery').getByText('They are better')).toHaveClass('text-warn')
    expect(rowOf('Delivery').getByText('They are better')).not.toHaveClass('text-danger')
    expect(rowOf('Support').getByText('We are better')).toHaveClass('text-ok')
  })

  it('tones even neutral, with no footnote when every row compares', () => {
    renderRows([{ category: 'pricing', theirs: side(30, 0.5), ours: side(40, 0.5), verdict: 'even', too_few: false }])
    expect(rowOf('Pricing').getByText('Even')).toHaveClass('text-muted')
    expect(screen.queryByTestId('compare-footnote')).not.toBeInTheDocument()
  })

  it('reads a row from an older API (no too_few) as too few under 10 of their reviews', () => {
    renderRows([{ category: 'delivery', theirs: side(4, 0.8), ours: side(40, 0.5), verdict: 'they_are_better' }])
    expect(rowOf('Delivery').getByText('Not enough reviews to compare')).toBeInTheDocument()
    expect(screen.queryByText('They are better')).not.toBeInTheDocument()
  })

  it('says when our side cannot be shown, and when nothing compares yet', () => {
    renderRows([], false)
    expect(screen.getByText(/your own side of the comparison is not shown/)).toBeInTheDocument()
    expect(screen.getByText('No category to compare yet.')).toBeInTheDocument()
  })
})
