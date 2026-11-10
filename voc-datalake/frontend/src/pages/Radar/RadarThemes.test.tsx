/**
 * Love and hate: one heading per top-level category with its total, its themes under it with their
 * counts, at most two quotes a theme and none twice in a column; a column without themes says so.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { defined } from '@test/defined'
import RadarThemes from './RadarThemes'
import { normalizeRadarPage } from '../../api/radarSchema'

const theme = (category: string, subcategory: string | null, count: number, quotes: string[]) => ({ category, subcategory, count, quotes })

function renderThemes(love: unknown[], sampled = false) {
  const detail = defined(normalizeRadarPage({ detail: {
    brand: { key: 'globex', label: 'Globex' }, total: 20, avg_sentiment: 0.2, trend: [], love, hate: [], sampled,
  } }).detail ?? undefined, 'themes detail')
  renderWithQueryClient(<MemoryRouter><RadarThemes detail={detail} onRead={vi.fn()} /></MemoryRouter>)
  return within(screen.getByRole('heading', { name: 'What their customers love' }).parentElement ?? document.body)
}

describe('Radar love and hate', () => {
  it('groups the themes under their category, with the category total and each theme count', () => {
    const love = renderThemes([
      theme('delivery', 'speed', 8, ['Arrived a day early.']),
      theme('delivery', 'tracking', 4, ['The live map is great.']),
      theme('pricing', null, 3, ['Fair price.']),
    ])
    const groups = love.getAllByTestId('radar-theme-group')
    expect(groups.map((group) => within(group).getByRole('heading').textContent)).toStrictEqual(['Delivery', 'Pricing'])
    expect(love.getByRole('button', { name: 'Read all 12 reviews in Delivery' })).toHaveTextContent('12 reviews')
    expect(love.getByRole('button', { name: 'Read the 8 reviews of Delivery / Speed' })).toHaveTextContent('8 reviews')
  })

  it('shows a category whose only theme has no subcategory as its heading and quotes, no "General" row', () => {
    const love = renderThemes([theme('pricing', null, 3, ['Fair price.'])])
    expect(love.queryByText('General')).not.toBeInTheDocument()
    expect(love.getByRole('button', { name: 'Read the 3 reviews of Pricing' })).toHaveTextContent('3 reviews')
    expect(love.getByText('Fair price.')).toBeInTheDocument()
  })

  it('names the no-subcategory theme "General" beside the category\'s other themes', () => {
    const love = renderThemes([theme('pricing', null, 3, ['Fair price.']), theme('pricing', 'discounts', 2, ['Good deals.'])])
    expect(love.getByText('General')).toBeInTheDocument()
    expect(love.getByRole('button', { name: 'Read all 5 reviews in Pricing' })).toBeInTheDocument()
  })

  it('shows at most two quotes a theme and never the same quote twice in a column', () => {
    const love = renderThemes([
      theme('delivery', 'speed', 8, ['Arrived a day early.', 'Fastest yet.', 'Third quote.']),
      theme('delivery', 'tracking', 4, ['Arrived a day early.', 'The live map is great.']),
    ])
    expect(love.getAllByText('Arrived a day early.')).toHaveLength(1)
    expect(love.queryByText('Third quote.')).not.toBeInTheDocument()
    expect(love.getByText('The live map is great.')).toBeInTheDocument()
  })

  it('replaces the per-quote "Read the review" pills with one count link a theme', () => {
    renderThemes([theme('delivery', 'speed', 1, ['Arrived a day early.'])])
    expect(screen.queryByText('Read the review')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read the review of Delivery / Speed' })).toHaveTextContent('1 review')
  })

  it('says when a column has nothing, and when the themes are read from a sample', () => {
    renderThemes([], true)
    expect(screen.getAllByText('Nothing stands out yet.')).toHaveLength(2)
    expect(screen.getByText('Read from the newest reviews of this window.')).toBeInTheDocument()
  })
})
