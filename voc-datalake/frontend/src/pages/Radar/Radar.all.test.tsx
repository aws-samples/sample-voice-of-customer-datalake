/**
 * Radar page, "All brands" (`?brand=all`, GET /radar/all): offered once two brands are tracked,
 * every brand side by side in a table whose names open each brand, and one release feed naming
 * the brand of every item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
import { adminFlag, fetchApi, resetFetchApi } from '@test/fetchApiRoutes'
import { createAppQueryClient } from '../../api/queryPolicies'
import { RELEASES, brand, renderPage, route } from './radar-fixtures'

const TWO = [brand('acme', 'Acme'), brand('globex', 'Example Air')]
const ACME_RELEASE = { ...RELEASES.releases[0], brand: { key: 'acme', label: 'Acme' } }
const AIR_RELEASE = { ...RELEASES.releases[0], feature: 'Seat maps', release_date: '2026-09-20', brand: { key: 'globex', label: 'Example Air' } }

function allPayload(extra: Record<string, unknown> = {}) {
  return {
    days: 90,
    brands: [
      { ...TWO[0], sentiment: { positive: 6, negative: 2, neutral: 2, mixed: 0 }, releases_in_window: 1, latest_release: ACME_RELEASE },
      { ...TWO[1], total: 0, avg_sentiment: null, releases_in_window: 0, latest_release: null },
    ],
    releases: [AIR_RELEASE, ACME_RELEASE], releases_total: 2, releases_capped: false,
    ...extra,
  }
}

const routeAll = (payload: unknown = allPayload()) => { route(TWO, { 'GET /radar/all': () => payload }) }
const allCalls = (): string[] => fetchApi.mock.calls.map(([endpoint]) => endpoint).filter((e) => e.startsWith('/radar/all'))

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Radar page, All brands', () => {
  it('offers "All brands" first once two brands are tracked', async () => {
    routeAll()
    renderPage()
    const select = await screen.findByLabelText('Brand')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toStrictEqual(['All brands', 'Acme', 'Example Air'])
    // The default stays the first brand (Home links rely on it).
    expect(select).toHaveValue('acme')
  })

  it('does not offer "All brands" with one brand, even when linked', async () => {
    route([brand('acme', 'Acme')])
    renderPage('/radar?brand=all')
    const select = await screen.findByLabelText('Brand')
    expect(within(select).queryByRole('option', { name: 'All brands' })).not.toBeInTheDocument()
    expect(select).toHaveValue('acme')
  })

  it('choosing it sets ?brand=all and reads every brand for the window', async () => {
    routeAll()
    renderPage()
    await userEvent.setup().selectOptions(await screen.findByLabelText('Brand'), 'all')
    expect(screen.getByTestId('search')).toHaveTextContent('?brand=all')
    expect(await screen.findByRole('table', { name: /Every tracked brand/ })).toBeInTheDocument()
    expect(allCalls()).toStrictEqual(['/radar/all?days=90'])
  })

  it('shows each brand\'s reviews, sentiment with its shares, and latest release', async () => {
    routeAll()
    renderPage('/radar?brand=all')
    const table = await screen.findByRole('table')
    const acme = within(within(table).getByRole('rowheader', { name: 'Acme' }).closest('tr') ?? table)
    expect(acme.getByText('Somewhat positive')).toBeInTheDocument()
    expect(acme.getByText('60% positive · 20% negative')).toBeInTheDocument()
    expect(acme.getByText('Dark mode')).toBeInTheDocument()
    expect(acme.getByText('Sep 1')).toBeInTheDocument()
  })

  it('says so for a brand without reviews or releases', async () => {
    routeAll()
    renderPage('/radar?brand=all')
    const table = await screen.findByRole('table')
    const air = within(within(table).getByRole('rowheader', { name: 'Example Air' }).closest('tr') ?? table)
    expect(air.getByText('No news yet')).toBeInTheDocument()
    expect(air.getByText('No reviews in this window')).toBeInTheDocument()
  })

  it('lists every brand\'s releases in one feed, newest first, each naming its brand', async () => {
    routeAll()
    renderPage('/radar?brand=all')
    const feed = await screen.findAllByTestId('radar-release')
    expect(feed.map((item) => within(item).getByTestId('release-brand').textContent)).toStrictEqual(['Example Air', 'Acme'])
    expect(screen.getByRole('heading', { name: 'Latest news across brands' })).toBeInTheDocument()
  })

  it('opens a brand from its name in the table', async () => {
    routeAll()
    renderPage('/radar?brand=all')
    const table = await screen.findByRole('table')
    await userEvent.setup().click(within(table).getByRole('button', { name: 'Open Example Air' }))
    expect(screen.getByTestId('search')).toHaveTextContent('?brand=globex')
    expect(await screen.findByText(/No news found yet/)).toBeInTheDocument()
  })

  it('opens a brand from its chip in the feed', async () => {
    routeAll()
    renderPage('/radar?brand=all')
    const [first] = await screen.findAllByTestId('radar-release')
    await userEvent.setup().click(within(first ?? document.body).getByRole('button', { name: 'Open Example Air' }))
    expect(screen.getByTestId('search')).toHaveTextContent('?brand=globex')
  })

  it('selects All from a linked ?brand=all and reads it for the chosen window', async () => {
    routeAll()
    // The app's own cache policy: the view reuses the page's early read, never asks twice.
    renderPage('/radar?brand=all&days=30', createAppQueryClient())
    expect(await screen.findByLabelText('Brand')).toHaveValue('all')
    await screen.findByRole('table')
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Window' }), '365')
    expect(screen.getByTestId('search')).toHaveTextContent('?brand=all&days=365')
    expect(allCalls()).toStrictEqual(['/radar/all?days=30', '/radar/all?days=365'])
  })

  it('says how many releases a capped feed leaves out', async () => {
    routeAll(allPayload({ releases_total: 1234, releases_capped: true }))
    renderPage('/radar?brand=all')
    expect(await screen.findByText('Showing the newest 2 of 1,234')).toBeInTheDocument()
  })

  it('shows no capped note when the feed is whole', async () => {
    routeAll()
    renderPage('/radar?brand=all')
    await screen.findByRole('table')
    expect(screen.queryByText(/Showing the newest/)).not.toBeInTheDocument()
  })

  it('says when no brand comes back', async () => {
    routeAll(allPayload({ brands: [], releases: [] }))
    renderPage('/radar?brand=all')
    expect(await screen.findByText('No brand is tracked yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('offers a retry when All brands cannot be loaded, and recovers', async () => {
    const answer = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('API Error: 500'))
    route(TWO, { 'GET /radar/all': answer })
    renderPage('/radar?brand=all')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Radar could not be loaded.')
    answer.mockResolvedValue(allPayload())
    await userEvent.setup().click(within(alert).getByRole('button'))
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })
})
