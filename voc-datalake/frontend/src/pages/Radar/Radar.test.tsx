/**
 * Radar page: the empty state explains how to add a Radar source; with a brand, one
 * aggregated view shows its trend, love / hate themes, cited releases and the comparison.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import Radar from './Radar'

const brand = (key: string, label: string) => ({ key, label, domains: [`${key}.example`], total: 3, avg_sentiment: 0.2 })
const DETAIL = {
  brand: { key: 'acme', label: 'Acme', domains: ['acme.example'] }, total: 3, avg_sentiment: 0.2,
  trend: [{ date: '2026-10-01', count: 3, avg_sentiment: 0.2 }],
  love: [{ category: 'ease_of_use', subcategory: 'installation_setup', count: 2, quotes: ['Arrived early'] }],
  hate: [{ category: 'billing', subcategory: null, count: 1, quotes: [] }],
}
const RELEASES = { releases: [{
  release_id: 'r1', feature: 'Dark mode', release_date: '2026-09-01', summary: 'Shipped dark mode.',
  urls: ['https://acme.example/news'], titles: ['Dark mode is here'], source_kind: 'official', mentions: 2,
}] }
const COMPARE = { ours_available: true, categories: [{
  category: 'ease_of_use', theirs: { volume: 2, positive_share: 0.8, negative_share: 0.1 },
  ours: { volume: 9, positive_share: 0.5, negative_share: 0.3 }, verdict: 'they_are_better',
}] }

function route(brands: unknown[]): void {
  routeFetchApi({
    'GET /radar': () => ({ brands, last_scan: null, settings: {} }),
    'GET /radar/brands/acme': () => DETAIL,
    'GET /radar/brands/acme/releases': () => RELEASES,
    'GET /radar/brands/acme/compare': () => COMPARE,
    'GET /radar/brands/globex': () => ({ ...DETAIL, brand: { key: 'globex', label: 'Globex' }, love: [] }),
    'GET /radar/brands/globex/releases': () => ({ releases: [] }),
    'GET /radar/brands/globex/compare': () => ({ categories: [] }),
  }, { ignoreQuery: true })
}

function Search() {
  return <output data-testid="search">{useLocation().search}</output>
}

const renderPage = (entry = '/radar') => renderWithQueryClient(
  <MemoryRouter initialEntries={[entry]}><Radar /><Search /></MemoryRouter>,
)

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Radar page', () => {
  it('explains how to add a Radar source, linking admins to the Radar setup card', async () => {
    route([])
    renderPage()
    expect(await screen.findByRole('heading', { name: 'No brand on the Radar yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set up Radar' })).toHaveAttribute('href', '/admin?tab=sources&section=radar')
  })

  it('hides the setup links from non-admins', async () => {
    adminFlag.isAdmin = false
    route([])
    renderPage()
    await screen.findByRole('heading', { name: 'No brand on the Radar yet' })
    expect(screen.queryByRole('link', { name: 'Set up Radar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Configure' })).not.toBeInTheDocument()
  })

  it('gives admins a Configure link to Administration -> Sources -> Radar in the header', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    expect(await screen.findByRole('link', { name: 'Configure' })).toHaveAttribute('href', '/admin?tab=sources&section=radar')
  })

  it('shows the first brand: love and hate themes with their counts and quotes', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const love = (await screen.findByRole('heading', { name: 'What their customers love' })).parentElement
    expect(within(love ?? document.body).getByText('Ease of use / Installation setup')).toBeInTheDocument()
    expect(within(love ?? document.body).getByText('Arrived early')).toBeInTheDocument()
    expect(screen.getByText('Billing')).toBeInTheDocument()
  })

  it('cites every release with a link to its source', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const link = await screen.findByRole('link', { name: /Dark mode is here/ })
    expect(link).toHaveAttribute('href', 'https://acme.example/news')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('Official')).toBeInTheDocument()
  })

  it('compares us with them per category', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const row = (await screen.findByRole('rowheader', { name: 'Ease of use' })).closest('tr')
    expect(within(row ?? document.body).getByText('They are better')).toBeInTheDocument()
    expect(within(row ?? document.body).getByText('80% positive')).toBeInTheDocument()
  })

  it('cautions a verdict drawn from fewer than 10 reviews, and links our side to our Categories', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const row = within((await screen.findByRole('rowheader', { name: 'Ease of use' })).closest('tr') ?? document.body)
    expect(row.getByText('Few reviews (under 10): read with care')).toBeInTheDocument()
    expect(row.getByRole('link', { name: 'Open our 9 reviews in Ease of use in Categories' })).toHaveAttribute('href', '/categories?category=ease_of_use')
  })

  it('offers the header\'s windows by the header\'s names, plus a year, opening on 90 days', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const select = await screen.findByRole('combobox', { name: 'Window' })
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toStrictEqual(['7 Days', '30 Days', '90 Days', 'Last 365 days'])
    expect(select).toHaveValue('90')
  })

  it('cites each page once, over https, however often the scan found it', async () => {
    routeFetchApi({
      'GET /radar': () => ({ brands: [brand('acme', 'Acme')], last_scan: null, settings: {} }),
      'GET /radar/brands/acme': () => DETAIL,
      'GET /radar/brands/acme/releases': () => ({ releases: [{
        ...RELEASES.releases[0],
        urls: ['http://www.acme.example/news/', 'https://acme.example/news', 'https://press.example/a'], titles: ['Dark mode is here', 'Dup', 'Press'],
      }] }),
      'GET /radar/brands/acme/compare': () => COMPARE,
    }, { ignoreQuery: true })
    renderPage()
    const sources = await screen.findByRole('list', { name: 'Sources' })
    const links = within(sources).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toStrictEqual(['https://www.acme.example/news/', 'https://press.example/a'])
  })

  // verify5/V6: a "example-air.example/changelog/2026-04-30-releases" label pushed the page to 449 px at 390 px / 200 %.
  it('lets a URL-like citation label break anywhere inside the page width', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    await screen.findByRole('link', { name: /Dark mode is here/ })
    const label = screen.getAllByTestId('citation-label').at(0)
    expect(label).toHaveClass('min-w-0', '[overflow-wrap:anywhere]')
    expect(label?.closest('a')).toHaveClass('max-w-full')
  })

  it('switches brand from the selector', async () => {
    route([brand('acme', 'Acme'), brand('globex', 'Globex')])
    renderPage()
    await screen.findByRole('link', { name: /Dark mode is here/ })
    await userEvent.setup().selectOptions(screen.getByLabelText('Brand'), 'globex')
    expect(await screen.findByText(/No release found yet/)).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/radar/brands/globex?days=90', undefined)
  })

  it('preselects the brand named by ?brand= (Home links there)', async () => {
    route([brand('acme', 'Acme'), brand('globex', 'Globex')])
    renderPage('/radar?brand=globex')
    expect(await screen.findByText(/No release found yet/)).toBeInTheDocument()
    expect(screen.getByLabelText('Brand')).toHaveValue('globex')
  })

  it('keeps ?brand= in step with the selector, keeping the other params', async () => {
    route([brand('acme', 'Acme'), brand('globex', 'Globex')])
    renderPage('/radar?brand=acme&review=fb_1')
    await screen.findByRole('link', { name: /Dark mode is here/ })
    await userEvent.setup().selectOptions(screen.getByLabelText('Brand'), 'globex')
    expect(screen.getByTestId('search')).toHaveTextContent('?review=fb_1&brand=globex')
  })

  it('keeps the window in ?days= so a shared link shows the same window', async () => {
    route([brand('acme', 'Acme')])
    renderPage('/radar?days=30')
    const select = await screen.findByRole('combobox', { name: 'Window' })
    expect(select).toHaveValue('30')
    await userEvent.setup().selectOptions(select, '365')
    expect(screen.getByTestId('search')).toHaveTextContent('?days=365')
    expect(fetchApi).toHaveBeenCalledWith('/radar/brands/acme?days=365', undefined)
  })

  it('falls back to 90 days for a window it does not offer', async () => {
    route([brand('acme', 'Acme')])
    renderPage('/radar?days=12')
    expect(await screen.findByRole('combobox', { name: 'Window' })).toHaveValue('90')
  })

  it('dates releases as "Sep 1, 2026", never an ISO date', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    expect(await screen.findByText('Sep 1, 2026')).toBeInTheDocument()
    expect(screen.queryByText('2026-09-01')).not.toBeInTheDocument()
  })

  it('says so when Radar cannot be loaded', async () => {
    routeFetchApi({})
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Radar could not be loaded.')
  })
})
