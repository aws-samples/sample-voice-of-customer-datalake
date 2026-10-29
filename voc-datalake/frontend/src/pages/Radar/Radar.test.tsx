/**
 * Radar page: the empty state explains how to add a Radar source; with a brand, one
 * aggregated view shows its trend, love / hate themes, cited releases and the comparison.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { COMPARE, DETAIL, RELEASES, brand, renderPage, route } from './radar-fixtures'

/** One brand, Acme, whose releases are `releases`. */
function routeReleases(releases: unknown[]): void {
  routeFetchApi({
    'GET /radar': () => ({ brands: [brand('acme', 'Acme')], last_scan: null, settings: {} }),
    'GET /radar/brands/acme/page': () => ({ detail: DETAIL, releases: { releases }, compare: COMPARE }),
  }, { ignoreQuery: true })
}

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

  it('lets an admin start the release and news scan from the Radar page, and says what it does', async () => {
    route([brand('acme', 'Acme')], { 'POST /radar/scan': () => ({ success: true, status: 'started' }) })
    renderPage()
    const scan = await screen.findByRole('button', { name: 'Scan now' })
    expect(scan).toHaveAccessibleDescription(/each brand's own domains for its releases and news/)
    expect(screen.getByText('No scan has run yet.')).toBeInTheDocument()
    await userEvent.setup().click(scan)
    expect(await screen.findByText(/The scan has started/)).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/radar/scan', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('offers no scan to a non-admin', async () => {
    adminFlag.isAdmin = false
    route([brand('acme', 'Acme')])
    renderPage()
    await screen.findByRole('heading', { name: 'What their customers love' })
    expect(screen.queryByRole('button', { name: 'Scan now' })).not.toBeInTheDocument()
  })

  it('offers no scan to an admin before any brand is tracked (the setup guide comes first)', async () => {
    route([])
    renderPage()
    await screen.findByRole('heading', { name: 'No brand on the Radar yet' })
    expect(screen.queryByRole('button', { name: 'Scan now' })).not.toBeInTheDocument()
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

  it('labels an undated release with the day it was first found, not as an approximate release day', async () => {
    routeReleases([
      { ...RELEASES.releases[0], release_id: 'r2', feature: 'Inbox', release_date: '2026-10-25', date_approximate: true },
      RELEASES.releases[0],
    ])
    renderPage()
    const undated = (await screen.findByRole('heading', { name: 'Inbox' })).closest('li')
    expect(undated).toHaveTextContent(/Date not published, first found Oct 25/)
    const dated = screen.getByRole('heading', { name: 'Dark mode' }).closest('li')
    expect(dated).not.toHaveTextContent(/Date not published/)
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
    routeReleases([{
      ...RELEASES.releases[0],
      urls: ['http://www.acme.example/news/', 'https://acme.example/news', 'https://press.example/a'], titles: ['Dark mode is here', 'Dup', 'Press'],
    }])
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
    expect(await screen.findByText(/No news found yet/)).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/radar/brands/globex/page?days=90', undefined)
  })

  it('preselects the brand named by ?brand= (Home links there)', async () => {
    route([brand('acme', 'Acme'), brand('globex', 'Globex')])
    renderPage('/radar?brand=globex')
    expect(await screen.findByText(/No news found yet/)).toBeInTheDocument()
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
    expect(fetchApi).toHaveBeenCalledWith('/radar/brands/acme/page?days=365', undefined)
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
