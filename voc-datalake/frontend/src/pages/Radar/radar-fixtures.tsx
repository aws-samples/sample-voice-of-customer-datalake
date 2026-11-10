/**
 * Radar page spec fixtures, shared by Radar.test.tsx and Radar.all.test.tsx: tracked brands,
 * Acme's page read, the routed API and the page rendered with its URL search on screen.
 * Each spec still declares its own `vi.mock`s (they are hoisted per file).
 */
import { MemoryRouter } from 'react-router-dom'
import LocationSearch from '@test/LocationSearch'
import { renderWithQueryClient } from '@test/query-client'
import { routeFetchApi } from '@test/fetchApiRoutes'
import type { QueryClient } from '@tanstack/react-query'
import Radar from './Radar'

export const brand = (key: string, label: string) => ({ key, label, domains: [`${key}.example`], total: 3, avg_sentiment: 0.2 })

export const DETAIL = {
  brand: { key: 'acme', label: 'Acme', domains: ['acme.example'] }, total: 3, avg_sentiment: 0.2,
  trend: [{ date: '2026-10-01', count: 3, avg_sentiment: 0.2 }],
  love: [{ category: 'ease_of_use', subcategory: 'installation_setup', count: 2, quotes: ['Arrived early'] }],
  hate: [{ category: 'billing', subcategory: null, count: 1, quotes: [] }],
}
export const RELEASES = { releases: [{
  release_id: 'r1', feature: 'Dark mode', release_date: '2026-09-01', summary: 'Shipped dark mode.',
  urls: ['https://acme.example/news'], titles: ['Dark mode is here'], source_kind: 'official', mentions: 2,
}] }
export const COMPARE = { ours_available: true, categories: [{
  category: 'ease_of_use', theirs: { volume: 2, positive_share: 0.8, negative_share: 0.1 },
  ours: { volume: 9, positive_share: 0.5, negative_share: 0.3 }, verdict: 'they_are_better',
}] }

/** The overview lists `brands`; Acme and Globex answer their page reads; `extra` adds routes (or replaces a page read). */
export function route(brands: unknown[], extra: Parameters<typeof routeFetchApi>[0] = {}): void {
  routeFetchApi({
    'GET /radar': () => ({ brands, last_scan: null, settings: {} }),
    'GET /radar/brands/acme/page': () => ({ detail: DETAIL, releases: RELEASES, compare: COMPARE }),
    'GET /radar/brands/globex/page': () => ({
      detail: { ...DETAIL, brand: { key: 'globex', label: 'Globex' }, love: [] }, releases: { releases: [] }, compare: { categories: [] },
    }),
    ...extra,
  }, { ignoreQuery: true })
}

/** `client`: the app's own cache policy when a spec counts requests (else the test default). */
export const renderPage = (entry = '/radar', client?: QueryClient) => renderWithQueryClient(
  <MemoryRouter initialEntries={[entry]}><Radar /><LocationSearch /></MemoryRouter>, client,
)
