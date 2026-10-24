/**
 * Connector approval cards (create_scraper, update_scraper, create_app_connector):
 * every saved field is rendered deterministically from the args, an update
 * diffs against the stored scraper read at render, and approval runs the
 * admin-only REST write — refusing a colliding id or a scraper that changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)
vi.mock('../../store/authStore', fetchApiDoubles.authStoreModule)

import { api } from '../../api/client'
import { resetExecutions } from './executionStore'
import { SCRAPER_CHANGED_MESSAGE } from './scraperExecutors'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { approve, fieldOf as field, outcomeOf, renderApprovalCard, resumedToolMessage, writes as saves } from '@test/approvalCardHarness'
import type { AssistantToolCall } from '../types'

const CREATE = {
  id: 'acme', name: 'Acme reviews', extraction_method: 'css', base_url: 'https://www.acme.example/reviews?page=1',
  urls: ['https://shop.acme.example/r'], container_selector: '.review', text_selector: '.body',
  frequency_minutes: 60, tags: ['web'], dimension_defaults: { product: 'mobile' },
}
const STORED = {
  id: 'scraper_1', name: 'Product Reviews', enabled: true, base_url: 'https://example.com/reviews', urls: [],
  frequency_minutes: 30, extraction_method: 'css', container_selector: '.review', text_selector: '.review-text',
  pagination: { enabled: true, param: 'page', max_pages: 3, start: 1 },
}

beforeEach(() => {
  vi.clearAllMocks()
  resetFetchApi()
  resetExecutions()
  adminFlag.isAdmin = true
  return stubElementScrollIntoView()
})

const renderCard = (toolCall: AssistantToolCall) => renderApprovalCard(toolCall, { kind: 'scrapers', path: '/scrapers' })

function routes(extra: Record<string, RouteHandler> = {}) {
  routeFetchApi({ 'GET /scrapers': () => ({ scrapers: [STORED] }), 'POST /scrapers': (body) => ({ success: true, saved: body }), ...extra })
}

describe('create_scraper card', () => {
  const card = () => renderCard({ id: 'c1', name: 'create_scraper', args: CREATE })

  it('is titled in plain words and says nothing is saved until approval', () => {
    card()
    expect(screen.getByRole('region', { name: 'Add a review source (web page)' })).toBeInTheDocument()
    expect(screen.getByText('Nothing is saved until you approve.')).toBeInTheDocument()
  })

  it('lists every URL on its own line with the host emphasised', () => {
    card()
    const items = field('urls').getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toStrictEqual(['https://www.acme.example/reviews?page=1', 'https://shop.acme.example/r'])
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toStrictEqual(['www.acme.example', 'shop.acme.example'])
  })

  it('shows the saved defaults: disabled, schedule as stored, pagination off', () => {
    card()
    expect(field('enabled').getByText('No')).toBeInTheDocument()
    expect(field('frequency_minutes').getByText('Every 60 minutes')).toBeInTheDocument()
    expect(field('pagination').getByText('Off')).toBeInTheDocument()
    expect(field('title_selector').getByText('Not set')).toBeInTheDocument()
  })

  it('shows id, method, selectors, dimension defaults and tags', () => {
    card()
    expect(field('id').getByText('acme')).toBeInTheDocument()
    expect(field('extraction_method').getByText('CSS selectors')).toBeInTheDocument()
    expect(field('container_selector').getByText('.review')).toBeInTheDocument()
    expect([field('dimension_defaults').getByText('product = mobile'), field('tags').getByText('web')]).toHaveLength(2)
  })

  // Live 5.14 review: selectors, ids and paging read as code to a product manager.
  it('keeps the technical rows behind a closed "Details" and the plain ones in view', () => {
    card()
    const details = screen.getByTestId('field-container_selector').closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(['id', 'extraction_method', 'pagination'].every((key) => screen.getByTestId(`field-${key}`).closest('details') === details)).toBe(true)
    expect(['name', 'urls', 'frequency_minutes'].some((key) => screen.getByTestId(`field-${key}`).closest('details') !== null)).toBe(false)
  })

  it('renders "Off" for a zero schedule', () => {
    renderCard({ id: 'c0', name: 'create_scraper', args: { ...CREATE, frequency_minutes: 0 } })
    expect(field('frequency_minutes').getByText('Off')).toBeInTheDocument()
  })

  it('on approve, POSTs exactly the shown record, refreshes the Scrapers list and links to the scraper', async () => {
    routes()
    const { user, onResolve, invalidate } = card()
    await approve(user, onResolve)
    expect(saves()).toStrictEqual([['/scrapers', 'POST', { scraper: {
      id: 'acme', name: 'Acme reviews', extraction_method: 'css', base_url: 'https://www.acme.example/reviews?page=1',
      urls: ['https://shop.acme.example/r'], container_selector: '.review', text_selector: '.body', frequency_minutes: 60,
      dimension_defaults: { product: 'mobile' }, tags: ['web'], enabled: false,
      pagination: { enabled: false, param: 'page', max_pages: 1, start: 1 },
    } }]])
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['scrapers'])
    expect(screen.getByRole('link', { name: 'Open this scraper on the Scrapers page' })).toHaveAttribute('href', '/scrapers#scraper-acme')
  })

  it('refuses an id that exists right before executing, and saves nothing', async () => {
    routes({ 'GET /scrapers': () => ({ scrapers: [{ ...STORED, id: 'acme' }] }) })
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'failed',
      error: 'A scraper with id "acme" already exists; nothing was saved. A create never overwrites — propose update_scraper, or a different id.',
    })
    expect(saves()).toStrictEqual([])
  })

  it('resumes the thread with the executed outcome as the tool message', async () => {
    routes()
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(resumedToolMessage(onResolve, 'c1')).toStrictEqual({
      status: 'executed',
      summary: 'Created web scraper "Acme reviews" (acme), disabled, not scheduled. It has not run yet; run_scraper starts a run.',
      data: { scraper_id: 'acme' },
    })
  })
})

describe('update_scraper card', () => {
  const card = (updates: Record<string, unknown> = { frequency_minutes: 120, name: 'Renamed' }) =>
    renderCard({ id: 'u1', name: 'update_scraper', args: { scraper_id: 'scraper_1', updates } })

  it('diffs the changed fields before → after against the stored scraper and collapses the rest', async () => {
    routes()
    card()
    const name = within(await screen.findByTestId('diff-name'))
    expect([name.getByText('Product Reviews'), name.getByText('Renamed')]).toHaveLength(2)
    expect(within(screen.getByTestId('diff-frequency_minutes')).getByText('Every 120 minutes')).toBeInTheDocument()
    expect(screen.getByText('16 unchanged fields')).toBeInTheDocument()
  })

  it('on approve, POSTs the stored scraper merged with the change', async () => {
    routes()
    const { user, onResolve } = card()
    await screen.findByTestId('diff-name')
    await approve(user, onResolve)
    expect(saves().at(0)?.[2]).toMatchObject({ scraper: { ...STORED, name: 'Renamed', frequency_minutes: 120 } })
  })

  it('refuses when the scraper changed after the card was shown, and saves nothing', async () => {
    routes()
    const { user, onResolve } = card()
    await screen.findByTestId('diff-name')
    routes({ 'GET /scrapers': () => ({ scrapers: [{ ...STORED, text_selector: '.edited-elsewhere' }] }) })
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: SCRAPER_CHANGED_MESSAGE })
    expect(saves()).toStrictEqual([])
  })

  it('says so when the scraper does not exist', async () => {
    routes({ 'GET /scrapers': () => ({ scrapers: [] }) })
    card()
    expect(await screen.findByRole('alert')).toHaveTextContent('Scraper scraper_1 was not found, so approving will save nothing.')
  })
})

describe('create_app_connector card', () => {
  const ARGS = { source: 'app_reviews_android', app_name: 'Acme app', package_name: 'com.acme.app', sort_by: 'rating' }

  it('shows every saved field with its default', () => {
    renderCard({ id: 'a1', name: 'create_app_connector', args: ARGS })
    expect(screen.getByRole('region', { name: 'Add a review source (app or review site)' })).toBeInTheDocument()
    expect(field('package_name').getByText('com.acme.app')).toBeInTheDocument()
    expect(field('max_reviews_per_run').getByText('500')).toBeInTheDocument()
    expect(field('frequency_minutes').getByText('Off')).toBeInTheDocument()
  })

  // `api.*` calls the client's own fetchApi, so the app routes are stubbed on the api object itself.
  const stubApps = (apps: Array<Record<string, string>>) => ({
    list: vi.spyOn(api, 'getAppConfigs').mockResolvedValue({ apps }),
    save: vi.spyOn(api, 'saveAppConfig').mockResolvedValue({ success: true, app: { id: 'ab12cd34' } }),
  })

  it('on approve, saves the shown app config to the store\u2019s apps route', async () => {
    const { save } = stubApps([])
    const { user, onResolve } = renderCard({ id: 'a2', name: 'create_app_connector', args: ARGS })
    await approve(user, onResolve)
    expect(save.mock.calls).toStrictEqual([['app_reviews_android', {
      app_name: 'Acme app', package_name: 'com.acme.app', sort_by: 'rating', max_reviews_per_run: '500', frequency_minutes: '0',
    }]])
  })

  it('refuses an app that is already configured, and saves nothing', async () => {
    const { save } = stubApps([{ id: 'x', app_name: 'Other', package_name: 'com.acme.app' }])
    const { user, onResolve } = renderCard({ id: 'a3', name: 'create_app_connector', args: ARGS })
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: 'An app connector for "Acme app" is already configured; nothing was saved.' })
    expect(save).not.toHaveBeenCalled()
  })

  const WEB = { source: 'web_reviews', app_name: 'Acme Trustpilot', url: 'https://www.trustpilot.com/review/acme.example' }

  it('shows a web review page with its URL, the latest 10 pages and no review limit by default', () => {
    renderCard({ id: 'w1', name: 'create_app_connector', args: WEB })
    expect(field('source').getByText('Web review page')).toBeInTheDocument()
    expect(field('url').getByText(WEB.url)).toBeInTheDocument()
    expect(field('max_pages').getByText('10 pages')).toBeInTheDocument()
    expect(field('max_reviews').getByText('No review limit')).toBeInTheDocument()
  })

  it('shows "latest 200 reviews" as all pages, up to 200 reviews', () => {
    renderCard({ id: 'w3', name: 'create_app_connector', args: { ...WEB, max_pages: 0, max_reviews: 200 } })
    expect(field('max_pages').getByText('All pages')).toBeInTheDocument()
    expect(field('max_reviews').getByText('Up to 200 reviews')).toBeInTheDocument()
  })

  it('on approve, saves the web review target to the web_reviews apps route', async () => {
    const { save } = stubApps([])
    const { user, onResolve } = renderCard({ id: 'w2', name: 'create_app_connector', args: { ...WEB, max_pages: 3, max_reviews: 50 } })
    await approve(user, onResolve)
    expect(save.mock.calls).toStrictEqual([['web_reviews', {
      app_name: 'Acme Trustpilot', url: WEB.url, max_pages: '3', max_reviews: '50', frequency_minutes: '0',
    }]])
  })

  it('returns the source label the route minted, so the assistant can scope jobs to it', async () => {
    const { save } = stubApps([])
    save.mockResolvedValue({ success: true, app: { id: 'ab12cd34', source_id: 'web_trustpilot_example_air' } })
    const { user, onResolve } = renderCard({ id: 'w4', name: 'create_app_connector', args: { ...WEB, app_name: 'Example Air' } })
    await approve(user, onResolve)
    expect(resumedToolMessage(onResolve, 'w4')).toMatchObject({
      status: 'executed', data: { source: 'web_reviews', app_id: 'ab12cd34', source_id: 'web_trustpilot_example_air' },
    })
  })

  it('an app connector\u2019s result carries no source label', async () => {
    stubApps([])
    const { user, onResolve } = renderCard({ id: 'a4', name: 'create_app_connector', args: ARGS })
    await approve(user, onResolve)
    expect(resumedToolMessage(onResolve, 'a4')).toMatchObject({
      status: 'executed', data: { source: 'app_reviews_android', app_id: 'ab12cd34' },
    })
    expect(resumedToolMessage(onResolve, 'a4')).not.toHaveProperty('data.source_id')
  })
})

describe('admin gating on the card', () => {
  it('a non-admin cannot approve a connector write', () => {
    adminFlag.isAdmin = false
    renderCard({ id: 'n1', name: 'create_scraper', args: CREATE })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByText('Only administrators can approve this action. You can still decline it.')).toBeInTheDocument()
  })
})
