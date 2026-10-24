/**
 * Administration -> Radar: the cadence and cost guards save as one PUT; "Scan now"
 * starts the worker and says so; the last scan is described; the brands tracked come
 * from GET /radar/brands with their 90-day counts from GET /radar (the editor itself:
 * RadarBrandsEditor.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { sourceLabel } from '../../utils/displayLabels'
import RadarSection from './RadarSection'

const LAST_SCAN = { status: 'completed', finished_at: '2026-10-15T05:46:00Z', brands: 2, queries: 12, added: 3, merged: 1 }

const ACME = { key: 'acme', label: 'Acme', domains: ['acme.example', 'blog.acme.example'], sources: ['rival_reviews', 'web_trustpilot_acme'], total: 28 }
const ACME_ENTRY = { key: 'acme', label: 'Acme', domains: ['acme.example', 'blog.acme.example'], origin: 'list', sources: ['rival_reviews', 'web_trustpilot_acme'] }

function route(scan: (body: unknown) => unknown = () => ({ success: true, status: 'started' }), brands: unknown[] = [], lastScan: unknown = LAST_SCAN): void {
  routeFetchApi({
    'GET /radar': () => ({ brands, last_scan: lastScan, settings: { cadence: 'weekly', max_brands: 10, query_cap: 30 } }),
    'GET /radar/brands': () => ({ brands: brands.length === 0 ? [] : [ACME_ENTRY] }),
    'PUT /radar/settings': (body) => ({ success: true, settings: body }),
    'POST /radar/scan': scan,
    'GET /settings/sources': () => ({ sources: [{ id: 'rival_reviews', label: 'Rival reviews' }] }),
  })
}

const lastBody = (path: string): unknown =>
  JSON.parse(String(fetchApi.mock.calls.filter(([endpoint]) => endpoint === path).at(-1)?.[1]?.body))

const renderSection = () => renderWithQueryClient(<MemoryRouter><RadarSection /></MemoryRouter>)

beforeEach(() => {
  resetFetchApi()
  route()
})

describe('RadarSection', () => {
  it('saves the cadence and both caps in one PUT', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.selectOptions(await screen.findByLabelText('Scan cadence'), 'daily')
    await user.clear(screen.getByLabelText('Web searches per scan (at most)'))
    await user.type(screen.getByLabelText('Web searches per scan (at most)'), '12')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Radar settings saved.')).toBeInTheDocument()
    expect(lastBody('/radar/settings')).toStrictEqual({ cadence: 'daily', max_brands: 10, query_cap: 12 })
  })

  it('describes the last scan', async () => {
    renderSection()
    expect(await screen.findByText(/Last scan: completed/)).toHaveTextContent('2 brands, 12 searches, 3 new releases, 1 merged')
  })

  it('pluralizes each count and writes the time in the locale, not as a raw ISO timestamp', async () => {
    route(undefined, [], { ...LAST_SCAN, brands: 1, queries: 1, added: 0 })
    renderSection()
    const line = await screen.findByText(/Last scan: completed/)
    const when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(LAST_SCAN.finished_at))
    expect(line).toHaveTextContent(`Last scan: completed, ${when} (1 brand, 1 search, 0 new releases, 1 merged)`)
    expect(line).not.toHaveTextContent('2026-10-15T05:46')
  })

  it('starts a scan now and says it started', async () => {
    renderSection()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Scan now' }))
    expect(await screen.findByText(/The scan has started/)).toBeInTheDocument()
    expect(lastBody('/radar/scan')).toStrictEqual({})
  })

  it('says so when the scan cannot start', async () => {
    route(() => { throw new Error('API Error: 400') })
    renderSection()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Scan now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The scan could not be started.')
  })
})

describe('RadarSection setup guide', () => {
  it('lists each tracked brand with its 90-day reviews, domains and labelled sources', async () => {
    route(undefined, [ACME])
    renderSection()
    const row = (await screen.findByText('Acme')).closest('li')
    expect(row).toHaveTextContent('Brand list')
    expect(row).toHaveTextContent('28 reviews in 90 days')
    expect(row).toHaveTextContent('Domains: acme.example, blog.acme.example')
    await within(row ?? document.body).findByText('Rival reviews')
    expect(within(row ?? document.body).getByText(sourceLabel('web_trustpilot_acme'))).toBeInTheDocument()
  })

  it('says so when no brand is tracked, and offers to add one right here', async () => {
    renderSection()
    expect(await screen.findByText('No brand is tracked yet.')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Add a brand' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Add a brand' })).toBeNull()
  })

  it('explains how Radar works in three steps, above the scan settings', async () => {
    renderSection()
    const how = (await screen.findByRole('heading', { name: 'How Radar works' })).closest('section')
    expect(within(how ?? document.body).getAllByRole('listitem')).toHaveLength(3)
    expect(within(how ?? document.body).getByText(/never to your dashboards/)).toBeInTheDocument()
    expect(how?.compareDocumentPosition(screen.getByLabelText('Scan cadence'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})

describe('RadarSection when the overview cannot be read', () => {
  it('says so with a retry instead of claiming no brand is tracked, and recovers on retry', async () => {
    routeFetchApi({}, { missStatus: 500 })
    const user = userEvent.setup()
    renderSection()
    expect(await screen.findByRole('alert')).toHaveTextContent('Radar could not be loaded.')
    expect(screen.queryByText(/No brand is tracked yet/i)).toBeNull()
    route(undefined, [ACME])
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Acme')).toBeInTheDocument()
  })
})
