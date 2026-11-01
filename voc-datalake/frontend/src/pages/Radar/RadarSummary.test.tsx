/**
 * The Radar summary strip: their positive share against ours (or why it cannot compare: an older
 * API, too few of their reviews, no side of ours), the releases of the window with the newest one,
 * and the biggest category gap. A tile with something behind it opens it.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { defined } from '@test/defined'
import RadarSummary from './RadarSummary'
import { normalizeRadarPage } from '../../api/radarSchema'
import type { RadarRelease } from '../../api/radarSchema'

const side = (volume: number, positive: number | null) => ({ volume, positive_share: positive, negative_share: 0.1 })
const today = new Date().toISOString().slice(0, 10)

function page(compare: unknown, total = 28) {
  const parsed = normalizeRadarPage({
    detail: { brand: { key: 'globex', label: 'Globex' }, total, avg_sentiment: 0.12, trend: [], love: [], hate: [] },
    compare,
    releases: { releases: [
      { release_id: 'r1', feature: 'Seat maps', release_date: today, urls: [], titles: [] },
      { release_id: 'r2', feature: 'Old news', release_date: '2020-01-01', urls: [], titles: [] },
    ] },
  })
  return { ...parsed, detail: defined(parsed.detail ?? undefined, 'summary detail') }
}

function renderSummary(compare: unknown, { total = 28, releases }: { total?: number; releases?: readonly RadarRelease[] } = {}) {
  const onRead = vi.fn()
  const data = page(compare, total)
  renderWithQueryClient(
    <MemoryRouter>
      <RadarSummary detail={data.detail} compare={data.compare} releases={releases ?? data.releases} days={90} onRead={onRead} />
    </MemoryRouter>,
  )
  return onRead
}

const COMPARED = {
  ours_available: true,
  overall: { theirs: side(28, 0.5), ours: side(120, 0.55) },
  categories: [
    { category: 'delivery', theirs: side(12, 0.8), ours: side(40, 0.55), verdict: 'they_are_better' },
    { category: 'pricing', theirs: side(4, 0.1), ours: side(18, 0.9), verdict: 'we_are_better' },
  ],
}

describe('Radar summary strip', () => {
  it('sets their positive share against ours, with both review counts, and opens every review', async () => {
    const onRead = renderSummary(COMPARED)
    const tile = screen.getByRole('button', { name: /Their sentiment against yours/ })
    expect(tile).toHaveTextContent('50% positive for them, 55% for you')
    expect(tile).toHaveTextContent('28 of their reviews · 120 of yours')
    expect(tile).toHaveTextContent('28 reviews · ')
    await userEvent.setup().click(tile)
    expect(onRead).toHaveBeenCalledWith({})
  })

  it('says plainly when too few of their reviews compare', () => {
    renderSummary({ ...COMPARED, overall: { theirs: side(6, 0.5), ours: side(120, 0.5) } })
    expect(screen.getByText('Only 6 of their reviews: too few to compare')).toBeInTheDocument()
  })

  it('says when our own side is not available', () => {
    renderSummary({ ...COMPARED, overall: { theirs: side(28, 0.5), ours: null } })
    expect(screen.getByText('50% positive for them; your own reviews are not available to compare')).toBeInTheDocument()
  })

  it('says it cannot compare yet on an API without the overall shares', () => {
    renderSummary({ categories: [] })
    expect(screen.getByText(/Cannot compare yet/)).toBeInTheDocument()
  })

  it('is plain, not a button, when the window has no review', () => {
    renderSummary(COMPARED, { total: 0 })
    expect(screen.queryByRole('button', { name: /Their sentiment against yours/ })).not.toBeInTheDocument()
    expect(screen.getByText('No reviews in this window')).toBeInTheDocument()
  })

  it('counts the releases of the window, names the newest and links to the news section', () => {
    renderSummary(COMPARED)
    const tile = screen.getByRole('link', { name: /New releases/ })
    expect(tile).toHaveTextContent('1 in the last 90 days')
    expect(tile).toHaveTextContent('Newest: Seat maps')
    expect(tile).toHaveAttribute('href', '#radar-releases')
  })

  it('says none, without a link, when the window has no release', () => {
    renderSummary(COMPARED, { releases: [] })
    expect(screen.getByText('0 in the last 90 days')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /New releases/ })).not.toBeInTheDocument()
  })

  it('words the biggest comparable gap and opens their reviews in that category', async () => {
    const onRead = renderSummary(COMPARED)
    const tile = screen.getByRole('button', { name: /Biggest gap/ })
    expect(tile).toHaveTextContent('They lead on Delivery by 25 points')
    await userEvent.setup().click(tile)
    expect(onRead).toHaveBeenCalledWith({ category: 'delivery' })
  })

  it('says you lead when your share is higher', () => {
    renderSummary({ ...COMPARED, categories: [{ category: 'support', theirs: side(20, 0.3), ours: side(40, 0.6), verdict: 'we_are_better' }] })
    expect(screen.getByText('You lead on Support by 30 points')).toBeInTheDocument()
  })

  it('says you are even when the shares match', () => {
    renderSummary({ ...COMPARED, categories: [{ category: 'support', theirs: side(20, 0.6), ours: side(40, 0.6), verdict: 'even' }] })
    expect(screen.getByText('You are even on Support')).toBeInTheDocument()
  })

  it('says there is nothing to compare when every row has too few reviews', () => {
    renderSummary({ ...COMPARED, categories: [COMPARED.categories[1]] })
    expect(screen.getByText('Not enough reviews to compare yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Biggest gap/ })).not.toBeInTheDocument()
  })
})
