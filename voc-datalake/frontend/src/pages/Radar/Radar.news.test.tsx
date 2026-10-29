/**
 * Radar page, "News and releases": each item shows its kind (Release, Announcement, Promotion,
 * Partnership, Company news) and, only when our own web search did not find it, a muted
 * "via Exa" / "via feed"; a kind filter narrows the list on the client, in the brand view and
 * in the All brands feed (one component); the Brands table's "Latest news" shows the kind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
import { adminFlag, resetFetchApi } from '@test/fetchApiRoutes'
import { COMPARE, DETAIL, RELEASES, brand, renderPage, route } from './radar-fixtures'

const BASE = RELEASES.releases[0]
const item = (id: string, feature: string, kind: string, foundVia: string[], day: string) =>
  ({ ...BASE, release_id: id, feature, kind, found_via: foundVia, release_date: day })

const NEWS = [
  item('n1', 'Spring sale', 'promotion', ['exa'], '2026-09-20'),
  item('n2', 'Seat maps', 'release', ['web', 'exa'], '2026-09-10'),
  item('n3', 'Works with Example Air', 'partnership', ['feed'], '2026-09-05'),
  item('n4', 'New office', 'news', ['web'], '2026-09-01'),
]

const titles = (list: HTMLElement) => within(list).getAllByTestId('radar-release').map((li) => within(li).getByRole('heading').textContent)
/** The closest `selector` around `element` (a spec error when there is none). */
const around = (element: HTMLElement, selector: string): HTMLElement => {
  const found = element.closest(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`no ${selector} around ${element.textContent}`)
  return found
}
const releaseOf = (feature: string): HTMLElement => around(screen.getByRole('heading', { name: feature }), 'li')

/** Acme's page with its news section and the section's kind filter. */
const brandNews = async () => {
  renderPage('/radar?brand=acme')
  const section = await screen.findByRole('region', { name: 'News and releases' })
  return { section, filter: within(section).getByRole('group', { name: 'Filter by kind' }) }
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = false
})

describe('Radar page, a brand\'s news', () => {
  beforeEach(() => {
    route([brand('acme', 'Acme')], { 'GET /radar/brands/acme/page': () => ({ detail: DETAIL, releases: { releases: NEWS }, compare: COMPARE }) })
  })

  it('titles the section "News and releases" and badges each item with its kind', async () => {
    renderPage('/radar?brand=acme')
    const section = await screen.findByRole('region', { name: 'News and releases' })
    expect(within(section).getAllByTestId('news-kind').map((badge) => badge.textContent))
      .toStrictEqual(['Promotion', 'Release', 'Partnership', 'Company news'])
  })

  it('marks only what our own web search did not find, by where it came from', async () => {
    renderPage('/radar?brand=acme')
    await screen.findByRole('heading', { name: 'Spring sale' })
    expect(within(releaseOf('Spring sale')).getByTestId('found-via')).toHaveTextContent('via Exa')
    expect(within(releaseOf('Works with Example Air')).getByTestId('found-via')).toHaveTextContent('via feed')
    expect(within(releaseOf('Seat maps')).queryByTestId('found-via')).toBeNull()
    expect(within(releaseOf('New office')).queryByTestId('found-via')).toBeNull()
  })

  it('filters by kind on the page', async () => {
    const user = userEvent.setup()
    const { section, filter } = await brandNews()
    await user.click(within(filter).getByRole('button', { name: 'Partnership' }))
    expect(within(filter).getByRole('button', { name: 'Partnership' })).toHaveAttribute('aria-pressed', 'true')
    expect(titles(section)).toStrictEqual(['Works with Example Air'])
  })

  it('says so when a kind has nothing, and All shows every item again', async () => {
    const user = userEvent.setup()
    const { section, filter } = await brandNews()
    await user.click(within(filter).getByRole('button', { name: 'Announcement' }))
    expect(within(section).queryAllByTestId('radar-release')).toHaveLength(0)
    expect(within(section).getByText(/Nothing of the kind “Announcement” in this list/)).toBeInTheDocument()
    await user.click(within(filter).getByRole('button', { name: 'All' }))
    expect(titles(section)).toHaveLength(4)
  })
})

describe('Radar page, All brands news', () => {
  const air = { key: 'globex', label: 'Example Air' }
  const feed = [
    { ...NEWS[0], brand: air },
    { ...NEWS[1], brand: { key: 'acme', label: 'Acme' } },
    { ...NEWS[3], brand: air },
  ]
  beforeEach(() => {
    route([brand('acme', 'Acme'), brand('globex', 'Example Air')], {
      'GET /radar/all': () => ({
        days: 90, releases: feed, releases_total: 3, releases_capped: false,
        brands: [
          { ...brand('acme', 'Acme'), releases_in_window: 1, latest_release: feed[1] },
          { ...brand('globex', 'Example Air'), releases_in_window: 2, latest_release: feed[0] },
        ],
      }),
    })
  })

  it('shows the kind of each brand\'s latest news in the table', async () => {
    renderPage('/radar?brand=all')
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Latest news' })).toBeInTheDocument()
    const airRow = around(within(table).getByRole('button', { name: 'Open Example Air' }), 'tr')
    expect(within(airRow).getByTestId('news-kind')).toHaveTextContent('Promotion')
    expect(within(airRow).getByText('Spring sale')).toBeInTheDocument()
  })

  it('filters the combined feed by kind with the same chips', async () => {
    const user = userEvent.setup()
    renderPage('/radar?brand=all')
    const section = await screen.findByRole('region', { name: 'Latest news across brands' })
    await user.click(within(within(section).getByRole('group', { name: 'Filter by kind' })).getByRole('button', { name: 'Company news' }))
    expect(titles(section)).toStrictEqual(['New office'])
    expect(within(section).getByTestId('release-brand')).toHaveTextContent('Example Air')
  })
})
