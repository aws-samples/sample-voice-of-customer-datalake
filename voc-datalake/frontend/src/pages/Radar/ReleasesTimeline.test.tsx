/**
 * News and releases as compact rows: the newest five, then "Show all N" grouped by month; a row's
 * title discloses its summary and citations; a citation without a title reads as its host and path.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReleasesTimeline from './ReleasesTimeline'
import { normalizeRadarPage } from '../../api/radarSchema'

const item = (n: number, day: string, extra: Record<string, unknown> = {}) => ({
  release_id: `r${n}`, feature: `Feature ${n}`, release_date: day, summary: `Summary ${n}.`,
  urls: [`https://globex.example/news/${n}`], titles: [`Title ${n}`], source_kind: 'official', ...extra,
})

const RELEASES = normalizeRadarPage({ releases: { releases: [
  item(1, '2026-10-20'), item(2, '2026-10-05'), item(3, '2026-09-28', { kind: 'promotion' }), item(4, '2026-09-12'),
  item(5, '2026-08-30'), item(6, '2026-08-02'), item(7, '2026-11-01'),
] } }).releases

const titles = () => screen.getAllByTestId('radar-release').map((row) => within(row).getByRole('heading').textContent)

describe('Radar releases timeline', () => {
  it('shows the newest five first, then "Show all N"', () => {
    render(<ReleasesTimeline releases={RELEASES} />)
    expect(titles()).toStrictEqual(['Feature 7', 'Feature 1', 'Feature 2', 'Feature 3', 'Feature 4'])
    expect(screen.queryAllByTestId('release-month')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Show all 7' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows all of them by month once expanded', async () => {
    render(<ReleasesTimeline releases={RELEASES} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all 7' }))
    expect(titles()).toHaveLength(7)
    expect(screen.getAllByTestId('release-month').map((h) => h.textContent))
      .toStrictEqual(['November 2026', 'October 2026', 'September 2026', 'August 2026'])
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('offers no "Show all" for five items or fewer', () => {
    render(<ReleasesTimeline releases={RELEASES.slice(0, 5)} />)
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('opens a row to its summary and citations', async () => {
    render(<ReleasesTimeline releases={RELEASES} />)
    const toggle = screen.getByRole('button', { name: 'Feature 1' })
    const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeVisible()
    await userEvent.setup().click(toggle)
    expect(details).toBeVisible()
    expect(within(details ?? document.body).getByRole('link', { name: /Title 1/ })).toHaveAttribute('href', 'https://globex.example/news/1')
  })

  it('closes an open row again', async () => {
    const user = userEvent.setup()
    render(<ReleasesTimeline releases={RELEASES} />)
    const toggle = screen.getByRole('button', { name: 'Feature 1' })
    await user.click(toggle)
    expect(screen.getByText('Summary 1.')).toBeVisible()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Summary 1.')).not.toBeVisible()
  })

  it('names a citation without a title by its host and path', async () => {
    const [blank] = normalizeRadarPage({ releases: { releases: [item(9, '2026-10-01', { urls: ['https://www.globex.example/news/'], titles: [''] })] } }).releases
    render(<ReleasesTimeline releases={blank === undefined ? [] : [blank]} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Feature 9' }))
    expect(screen.getByTestId('citation-label')).toHaveTextContent(/^globex\.example\/news$/)
  })

  it('filters by kind first, and a kind with few items shows them all', async () => {
    const user = userEvent.setup()
    render(<ReleasesTimeline releases={RELEASES} />)
    await user.click(screen.getByRole('button', { name: 'Promotion' }))
    expect(titles()).toStrictEqual(['Feature 3'])
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('shows its note under the list', () => {
    render(<ReleasesTimeline releases={RELEASES} note="Showing the newest 100 of 240" />)
    expect(screen.getByText('Showing the newest 100 of 240')).toBeInTheDocument()
  })
})
