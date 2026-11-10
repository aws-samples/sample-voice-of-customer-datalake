/**
 * The muted "Radar: <brand>" badge on the Scrapers page: a custom scraper card and a Web Reviews
 * / app connector card whose `radar_brand` is set name the brand (label from GET /radar/brands,
 * the key until it loads or when the brand is unknown); an ordinary source shows none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '@test/query-client'
import { RADAR_BRANDS } from '@test/radarBrandFixtures'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { makeScraper, scrapersApiStubModule } from './scrapers-fixtures'
import ScraperCard from './ScraperCard'
import { AppConfigCard } from './AppConfigComponents'
import { useRadarBrandLabeler } from './useRadarBrands'
import type { PluginManifest } from '../../plugins/types'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../api/scrapersApi', async (importOriginal) => scrapersApiStubModule(importOriginal, { status: 'never_run' }))

const WEB_REVIEWS: PluginManifest = {
  id: 'web_reviews', name: 'Web Reviews', icon: 'Globe', description: 'Review pages', config: [],
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false, enabled: true,
}

const noop = () => {}

function queryWrapper() {
  const client = createTestQueryClient()
  return ({ children }: Readonly<{ children: ReactNode }>) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ 'GET /radar/brands': () => ({ brands: RADAR_BRANDS }) })
})

describe('Radar badge', () => {
  it('names the brand on a scraper card', () => {
    render(<ScraperCard scraper={makeScraper({ radar_brand: 'globex' })} radarBrandLabel="Globex" isAdmin onEdit={noop} onDelete={noop} onRun={noop} />)
    expect(screen.getByText('Radar: Globex')).toBeInTheDocument()
  })

  it('is absent on an ordinary scraper card', () => {
    render(<ScraperCard scraper={makeScraper({})} isAdmin onEdit={noop} onDelete={noop} onRun={noop} />)
    expect(screen.queryByText(/^Radar:/)).toBeNull()
  })

  it('names the brand on a Web Reviews connector card', () => {
    render(<AppConfigCard app={{ id: 'w1', app_name: 'Trustpilot - Globex', radar_brand: 'globex' }} plugin={WEB_REVIEWS}
      radarBrandLabel="Globex" isAdmin onEdit={noop} onDelete={noop} onRun={noop} isRunning={false} />)
    expect(screen.getByText('Radar: Globex')).toBeInTheDocument()
  })
})

describe('useRadarBrandLabeler', () => {
  it('reads the label from GET /radar/brands and falls back to the key', async () => {
    const { result } = renderHook(() => useRadarBrandLabeler(), { wrapper: queryWrapper() })
    await waitFor(() => { expect(result.current('globex')).toBe('Globex') })
    expect(result.current('initech')).toBe('initech')
    expect(result.current('')).toBeUndefined()
    expect(result.current(undefined)).toBeUndefined()
  })
})
