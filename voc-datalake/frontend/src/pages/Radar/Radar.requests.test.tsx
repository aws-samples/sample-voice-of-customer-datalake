/**
 * Radar page, what its first load asks for (the 5.34 live test: ~10 s to a first view).
 *
 * The page used to wait for `/radar`, then ask for a brand's detail, releases and compare at
 * once: four requests in two rounds, and the three parallel ones made a cold API function start
 * a second environment (two Init Durations of 1.3-1.4 s one after the other, CloudWatch
 * 2026-10-25). Now: `/radar` plus ONE page read, and a linked `?brand=` (and the label configs)
 * start while `/radar` is still on its way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { createAppQueryClient } from '../../api/queryPolicies'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../hooks/useCategories', () => ({ useCategoriesConfig: vi.fn(() => ({ data: undefined })) }))
vi.mock('../../hooks/useDimensions', () => ({ useSourceProfiles: vi.fn(() => ({ data: undefined })) }))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { useCategoriesConfig } from '../../hooks/useCategories'
import { useSourceProfiles } from '../../hooks/useDimensions'
import Radar from './Radar'

const brand = (key: string, label: string) => ({ key, label, domains: [], total: 1, avg_sentiment: 0 })
const page = (key: string, label: string) => ({
  detail: { brand: { key, label }, total: 1, avg_sentiment: 0, trend: [], love: [], hate: [] },
  releases: { releases: [] },
  compare: { ours_available: true, categories: [] },
})
const OVERVIEW = { brands: [brand('acme', 'Acme'), brand('globex', 'Globex')], last_scan: null, settings: {} }

/** `/radar` answers only when the test says so; the brand pages answer at once. */
function routeWithHeldOverview(): () => void {
  const waiting: Array<(overview: typeof OVERVIEW) => void> = []
  const held = new Promise<typeof OVERVIEW>((resolve) => { waiting.push(resolve) })
  routeFetchApi({
    'GET /radar': () => held,
    'GET /radar/brands/acme/page': () => page('acme', 'Acme'),
    'GET /radar/brands/globex/page': () => page('globex', 'Globex'),
  }, { ignoreQuery: true })
  return () => { waiting.forEach((resolve) => { resolve(OVERVIEW) }) }
}

const radarCalls = (): string[] => fetchApi.mock.calls.map(([endpoint]) => endpoint).filter((e) => e.startsWith('/radar'))

const renderPage = (entry = '/radar') => renderWithQueryClient(<MemoryRouter initialEntries={[entry]}><Radar /></MemoryRouter>)

beforeEach(() => {
  resetFetchApi()
  vi.mocked(useCategoriesConfig).mockClear()
  vi.mocked(useSourceProfiles).mockClear()
})

describe('Radar first load', () => {
  it('reads a brand with one request after the brand list, never the three views apart', async () => {
    const releaseOverview = routeWithHeldOverview()
    releaseOverview()
    renderPage()
    expect(await screen.findByText(/No news found yet/)).toBeInTheDocument()
    expect(radarCalls()).toStrictEqual(['/radar', '/radar/brands/acme/page?days=90'])
  })

  it('starts a linked brand\'s page while the brand list is still on its way, and reads it once', async () => {
    const release = routeWithHeldOverview()
    // The app's own cache policy: the view must reuse the early read, not ask again.
    renderWithQueryClient(<MemoryRouter initialEntries={['/radar?brand=globex&days=30']}><Radar /></MemoryRouter>, createAppQueryClient())
    await waitFor(() => { expect([...radarCalls()].sort((a, b) => a.localeCompare(b))).toStrictEqual(['/radar', '/radar/brands/globex/page?days=30']) })
    release()
    expect(await screen.findByLabelText('Brand')).toHaveValue('globex')
    expect(await screen.findByText(/No news found yet/)).toBeInTheDocument()
    expect(radarCalls().filter((e) => e.includes('/page'))).toStrictEqual(['/radar/brands/globex/page?days=30'])
  })

  it('asks for the label configs before the brand list answers', () => {
    routeWithHeldOverview()
    renderPage()
    expect(radarCalls()).toStrictEqual(['/radar'])
    expect(useCategoriesConfig).toHaveBeenCalledWith()
    expect(useSourceProfiles).toHaveBeenCalledWith()
  })
})
