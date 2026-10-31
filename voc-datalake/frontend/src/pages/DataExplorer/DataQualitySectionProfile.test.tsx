import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { emptyProfile, normalizeProfile } from '../../api/dataQualityProfileSchema'
import type { OverallQuality, SourceQuality } from '../../api/dataQualitySchema'
import DataQualitySectionProfile from './DataQualitySectionProfile'

const web: SourceQuality = {
  source: 'web', high: 4, medium: 0, low: 0, unrated: 2, total: 6,
  profile: normalizeProfile({
    profiled: 4, rating: { 5: 3, none: 1 }, sentiment: { negative: 3, positive: 1 }, length: { short: 1, very_long: 3 },
  }),
}
const app: SourceQuality = {
  source: 'app', high: 2, medium: 0, low: 0, unrated: 0, total: 2,
  profile: normalizeProfile({ profiled: 2, rating: { 1: 2 }, sentiment: { neutral: 2 }, length: { medium: 2 } }),
}

function overallOf(rows: readonly SourceQuality[], profile = emptyProfile()): OverallQuality {
  const sum = (field: 'high' | 'medium' | 'low' | 'unrated' | 'total') => rows.reduce((total, row) => total + row[field], 0)
  return { high: sum('high'), medium: sum('medium'), low: sum('low'), unrated: sum('unrated'), total: sum('total'), profile }
}

const ALL = normalizeProfile({ profiled: 6, rating: { 5: 3, 1: 2, none: 1 }, sentiment: { negative: 3, positive: 1, neutral: 2 } })
const name = (source: string) => `Label ${source}`

describe('DataQualitySectionProfile', () => {
  it('starts on the rating facet with every star column and the share of profiled reviews', () => {
    render(<DataQualitySectionProfile sources={[web, app]} overall={overallOf([web, app], ALL)} sourceName={name} />)
    const table = screen.getByRole('table', { name: 'Rating per source' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toStrictEqual(
      ['Source', '5 stars', '4 stars', '3 stars', '2 stars', '1 star', 'No rating', 'Profiled'])
    expect(within(table).getByRole('row', { name: /Label web/ })).toHaveTextContent('3(75%)0(0%)0(0%)0(0%)0(0%)1(25%)4')
    expect(within(table).getByRole('row', { name: /All sources/ })).toHaveTextContent('6')
    expect(screen.getByRole('button', { name: 'Rating' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches to sentiment and text length', async () => {
    const user = userEvent.setup()
    render(<DataQualitySectionProfile sources={[web, app]} overall={overallOf([web, app], ALL)} sourceName={name} />)
    await user.click(screen.getByRole('button', { name: 'Sentiment' }))
    const sentiment = screen.getByRole('table', { name: 'Sentiment per source' })
    expect(within(sentiment).getByRole('row', { name: /Label web/ })).toHaveTextContent('1(25%)0(0%)0(0%)3(75%)0(0%)4')
    await user.click(screen.getByRole('button', { name: 'Text length' }))
    const length = screen.getByRole('table', { name: 'Text length per source' })
    expect(within(length).getAllByRole('columnheader').map((h) => h.textContent)).toContain('1,000+ characters')
    expect(screen.getByRole('button', { name: 'Text length' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says how much feedback predates the profile, and nothing when all of it is profiled', () => {
    const { rerender } = render(
      <DataQualitySectionProfile sources={[web, app]} overall={overallOf([web, app], ALL)} sourceName={name} />)
    expect(screen.getByText(/25% of the feedback in this range was stored before the profile was counted/)).toBeInTheDocument()
    const complete = { ...web, unrated: 0, total: 4 }
    rerender(<DataQualitySectionProfile sources={[complete]} overall={overallOf([complete], web.profile)} sourceName={name} />)
    expect(screen.queryByText(/stored before the profile was counted/)).not.toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /All sources/ })).not.toBeInTheDocument()
  })
})
