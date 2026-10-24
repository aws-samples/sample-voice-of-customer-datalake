/**
 * Radar approval cards (save_radar_brands, run_radar_scan) and the "Radar
 * source" row of the connector cards: rows rendered from the args and the
 * brand list read at render; approval runs the admin-only REST write and the
 * brand-list save refuses a list that changed after the card was shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)
vi.mock('../../store/authStore', fetchApiDoubles.authStoreModule)

import { resetExecutions } from './executionStore'
import { RADAR_BRANDS_CHANGED_MESSAGE } from './radarExecutors'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { approve, fieldOf as field, outcomeOf, renderApprovalCard, resumedToolMessage, writes } from '@test/approvalCardHarness'
import type { AssistantToolCall } from '../types'

const STORED = {
  brands: [
    { key: 'acme-air', label: 'Acme Air', domains: ['acme-air.example'], origin: 'list', sources: [] },
    { key: 'example-air', label: 'Example Air', domains: [], origin: 'profile', sources: ['radar_example_air'] },
  ],
}
const SAVE = { brands: [{ label: 'Acme Air', domains: ['acme-air.example', 'news.acme-air.example'] }, { label: 'Globex' }] }

const renderCard = (toolCall: AssistantToolCall) => renderApprovalCard(toolCall, { kind: 'radar', path: '/radar' })

beforeEach(() => {
  adminFlag.isAdmin = true
  resetExecutions()
  resetFetchApi()
  vi.clearAllMocks()
  return stubElementScrollIntoView()
})

function routes(extra: Record<string, RouteHandler> = {}) {
  routeFetchApi({
    'GET /radar/brands': () => STORED,
    'PUT /radar/brands': (body) => ({ success: true, brands: STORED.brands, saved: body }),
    'POST /radar/scan': () => ({ success: true, status: 'started' }),
    'POST /scrapers': () => ({ success: true }),
    'GET /scrapers': () => ({ scrapers: [] }),
    ...extra,
  })
}

describe('save_radar_brands card', () => {
  const card = () => renderCard({ id: 'b1', name: 'save_radar_brands', args: SAVE })

  it('diffs every brand: a changed one before → after, a new one, and keeps profile brands', async () => {
    routes()
    card()
    expect(await screen.findByTestId('diff-acme-air')).toHaveTextContent('news.acme-air.example')
    expect(screen.getByTestId('diff-globex')).toHaveTextContent('Not tracked')
    expect(screen.getByText('Kept from source profiles: Example Air')).toBeInTheDocument()
  })

  it('on approve, PUTs the whole list and tells the model the keys', async () => {
    routes()
    const { user, onResolve } = card()
    await screen.findByTestId('diff-globex')
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/radar/brands', 'PUT', { brands: [{ label: 'Acme Air', domains: ['acme-air.example', 'news.acme-air.example'] }, { label: 'Globex', domains: [] }] }]])
    expect(resumedToolMessage(onResolve, 'b1')).toMatchObject({
      status: 'executed', data: { brands: [{ key: 'acme-air', label: 'Acme Air' }, { key: 'globex', label: 'Globex' }] },
    })
  })

  it('refuses when the stored list changed after the card was shown, and saves nothing', async () => {
    routes()
    const { user, onResolve } = card()
    await screen.findByTestId('diff-globex')
    routes({ 'GET /radar/brands': () => ({ brands: [{ key: 'initech', label: 'Initech', domains: [], origin: 'list', sources: [] }] }) })
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: RADAR_BRANDS_CHANGED_MESSAGE })
    expect(writes()).toStrictEqual([])
  })
})

describe('run_radar_scan card', () => {
  it('names the brand by its label and starts the scan for it', async () => {
    routes()
    const { user, onResolve } = renderCard({ id: 's1', name: 'run_radar_scan', args: { brand: 'acme-air' } })
    expect(await field('brand').findByText('Acme Air')).toBeInTheDocument()
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/radar/scan', 'POST', { brand: 'acme-air' }]])
  })

  it('without a brand scans every tracked brand', async () => {
    routes()
    const { user, onResolve } = renderCard({ id: 's2', name: 'run_radar_scan', args: {} })
    expect(field('brand').getByText('Every tracked brand')).toBeInTheDocument()
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/radar/scan', 'POST', {}]])
  })
})

describe('"Radar source" on the connector cards', () => {
  const scraper = { id: 'acme', name: 'Acme', extraction_method: 'jsonld', base_url: 'https://www.acme.example/reviews' }

  it('shows the brand label on a Radar scraper and saves its key', async () => {
    routes()
    const { user, onResolve } = renderCard({ id: 'c1', name: 'create_scraper', args: { ...scraper, radar_brand: 'acme-air' } })
    expect(await field('radar_brand').findByText('Acme Air')).toBeInTheDocument()
    await approve(user, onResolve)
    expect(writes().at(0)?.[2]).toMatchObject({ scraper: { radar_brand: 'acme-air' } })
  })

  it('says "our own feedback" on an ordinary scraper', () => {
    routes()
    renderCard({ id: 'c2', name: 'create_scraper', args: scraper })
    expect(field('radar_brand').getByText('No — our own feedback')).toBeInTheDocument()
  })
})
