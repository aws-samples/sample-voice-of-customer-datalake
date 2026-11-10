/**
 * Radar page: the empty state explains how to add a Radar source; with a brand, one
 * aggregated view shows, in order, the summary strip, the comparison, love / hate themes,
 * cited releases and the trend. Admins get one "Last scan · Scan now" line in the header.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
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

/** Open a release row (its title is a disclosure) and answer its row. */
async function openRelease(feature: string): Promise<HTMLElement> {
  const toggle = await screen.findByRole('button', { name: feature })
  await userEvent.setup().click(toggle)
  return toggle.closest('li') ?? document.body
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

  it('gives an admin one scan line in the header, with what the scan does as its description', async () => {
    route([brand('acme', 'Acme')], { 'POST /radar/scan': () => ({ success: true, status: 'started' }) })
    renderPage()
    const scan = await screen.findByRole('button', { name: 'Scan now' })
    expect(scan).toHaveAccessibleDescription(/each brand's own domains for its releases and news/)
    expect(scan).toHaveAttribute('title', expect.stringMatching(/without waiting for the schedule/))
    expect(screen.getByTestId('radar-last-scan')).toHaveTextContent('No scan yet')
  })

  it('starts the scan from the header line and says it has started', async () => {
    route([brand('acme', 'Acme')], { 'POST /radar/scan': () => ({ success: true, status: 'started' }) })
    renderPage()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Scan now' }))
    expect(await screen.findByText(/The scan has started/)).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/radar/scan', expect.objectContaining({ method: 'POST', body: '{}' }))
  })

  it('reads the overview again after a started scan, so the header line follows', async () => {
    route([brand('acme', 'Acme')], { 'POST /radar/scan': () => ({ success: true, status: 'started' }) })
    renderPage()
    await screen.findByRole('button', { name: 'Scan now' })
    const overviewReads = () => fetchApi.mock.calls.filter(([path]) => path === '/radar').length
    const before = overviewReads()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scan now' }))
    await waitFor(() => expect(overviewReads()).toBeGreaterThan(before))
  })

  it('dates the last scan short, with its status and counts in the tooltip', async () => {
    route([brand('acme', 'Acme')], {
      'GET /radar': () => ({
        brands: [brand('acme', 'Acme')], settings: {},
        last_scan: { status: 'completed', finished_at: '2026-10-30T09:00:00Z', brands: 1, queries: 15, added: 0, merged: 0 },
      }),
    })
    renderPage()
    const last = await screen.findByTestId('radar-last-scan')
    expect(last).toHaveTextContent('Last scan Oct 30')
    expect(last).toHaveAttribute('title', expect.stringMatching(/^Last scan: completed, .*\(1 brand, 15 searches, 0 new releases, 0 merged\)$/))
  })

  it('offers no scan to a non-admin', async () => {
    adminFlag.isAdmin = false
    route([brand('acme', 'Acme')])
    renderPage()
    await screen.findByRole('heading', { name: 'What their customers love' })
    expect(screen.queryByRole('button', { name: 'Scan now' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('radar-last-scan')).not.toBeInTheDocument()
  })

  it('offers no scan to an admin before any brand is tracked (the setup guide comes first)', async () => {
    route([])
    renderPage()
    await screen.findByRole('heading', { name: 'No brand on the Radar yet' })
    expect(screen.queryByRole('button', { name: 'Scan now' })).not.toBeInTheDocument()
  })

  it('reads top to bottom: summary, comparison, love and hate, news, trend', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    await screen.findByRole('heading', { name: 'What their customers love' })
    const order = ['Summary', 'Compared with us', 'What their customers love / What their customers hate', 'News and releases', 'Sentiment trend']
    const regions = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label') ?? region.querySelector('h2')?.textContent)
    expect(regions.filter((name) => order.includes(name ?? ''))).toStrictEqual(order)
  })

  it('shows the first brand: love and hate themes under their categories, with counts and quotes', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const love = within((await screen.findByRole('heading', { name: 'What their customers love' })).parentElement ?? document.body)
    expect(love.getByRole('heading', { name: 'Ease of use' })).toBeInTheDocument()
    expect(love.getByText('Installation setup')).toBeInTheDocument()
    expect(love.getByText('Arrived early')).toBeInTheDocument()
  })

  it('shows a category whose only theme has no subcategory as one heading with its quotes, no "General" row', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const hate = within((await screen.findByRole('heading', { name: 'What their customers hate' })).parentElement ?? document.body)
    expect(hate.getByRole('heading', { name: 'Billing' })).toBeInTheDocument()
    expect(hate.queryByText('General')).not.toBeInTheDocument()
  })

  it('keeps a release row closed until its title is pressed', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const toggle = await screen.findByRole('button', { name: 'Dark mode' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: /Dark mode is here/ })).not.toBeInTheDocument()
    await openRelease('Dark mode')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('cites every release with a link to its source, once the row is opened', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const row = within(await openRelease('Dark mode'))
    const link = row.getByRole('link', { name: /Dark mode is here/ })
    expect(link).toHaveAttribute('href', 'https://acme.example/news')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(row.getByText('Shipped dark mode.')).toBeInTheDocument()
  })

  it('names the site of the first citation on the row, and badges an official one', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const row = within((await screen.findByRole('button', { name: 'Dark mode' })).closest('li') ?? document.body)
    expect(row.getByTestId('release-site')).toHaveTextContent('acme.example')
    expect(row.getByText('Official')).toHaveClass('badge')
  })

  it('labels an undated release with the day it was first found, muted, not as an approximate release day', async () => {
    routeReleases([
      { ...RELEASES.releases[0], release_id: 'r2', feature: 'Inbox', release_date: '2026-10-25', date_approximate: true },
      RELEASES.releases[0],
    ])
    renderPage()
    const undated = (await screen.findByRole('button', { name: 'Inbox' })).closest('li')
    expect(undated).toHaveTextContent(/first found Oct 25, 2026/)
    expect(within(undated ?? document.body).getByText(/first found/)).toHaveClass('text-muted')
    expect(screen.getByRole('button', { name: 'Dark mode' }).closest('li')).not.toHaveTextContent(/first found/)
  })

  it('compares us with them per category, and says plainly when a row has too few of their reviews', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const row = within((await screen.findByRole('rowheader', { name: 'Ease of use' })).closest('tr') ?? document.body)
    expect(row.getByText('80% positive')).toBeInTheDocument()
    expect(row.getByText('Not enough reviews to compare')).toHaveClass('text-muted')
    expect(row.queryByText('They are better')).not.toBeInTheDocument()
    expect(row.getByRole('link', { name: 'Open our 9 reviews in Ease of use in Categories' })).toHaveAttribute('href', '/categories?category=ease_of_use')
  })

  it('names every window the same way, opening on the last 90 days', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    const select = await screen.findByRole('combobox', { name: 'Window' })
    expect([...select.querySelectorAll('option')].map((o) => o.textContent))
      .toStrictEqual(['Last 7 days', 'Last 30 days', 'Last 90 days', 'Last 365 days'])
    expect(select).toHaveValue('90')
  })

  it('cites each page once, over https, however often the scan found it', async () => {
    routeReleases([{
      ...RELEASES.releases[0],
      urls: ['http://www.acme.example/news/', 'https://acme.example/news', 'https://press.example/a'], titles: ['Dark mode is here', 'Dup', 'Press'],
    }])
    renderPage()
    const sources = within(await openRelease('Dark mode')).getByRole('list', { name: 'Sources' })
    const links = within(sources).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toStrictEqual(['https://www.acme.example/news/', 'https://press.example/a'])
  })

  // verify5/V6: a "example-air.example/changelog/2026-04-30-releases" label pushed the page to 449 px at 390 px / 200 %.
  it('lets a URL-like citation label break anywhere inside the page width', async () => {
    route([brand('acme', 'Acme')])
    renderPage()
    await openRelease('Dark mode')
    const label = screen.getAllByTestId('citation-label').at(0)
    expect(label).toHaveClass('min-w-0', '[overflow-wrap:anywhere]')
    expect(label?.closest('a')).toHaveClass('max-w-full')
  })

  it('switches brand from the selector', async () => {
    route([brand('acme', 'Acme'), brand('globex', 'Globex')])
    renderPage()
    await screen.findByRole('button', { name: 'Dark mode' })
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
    await screen.findByRole('button', { name: 'Dark mode' })
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
