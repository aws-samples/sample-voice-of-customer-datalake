/**
 * The cost page's client: `GET /platform/costs` as workspaces_handler.py and shared/platform_costs.py `cost_page`
 * answer it (a dollar figure a decimal string or null), and the lenient read: a drifted workspace row costs itself
 * (and is counted), an answer with no page is an error, never "no cost".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { parseCostPage, platformCostsApi, platformCostsKey } from './platformCostsApi'

beforeEach(() => resetFetchApi())

const SUM = {
  calls: 4, input_tokens: 1200, output_tokens: 300, cache_read_tokens: 10, cache_write_tokens: 5,
  estimated_usd: '0.750000', complete: true, unpriced_models: [],
}
const MODEL_LINE = { model_id: 'model-alpha', service_tier: 'default', ...SUM }
const SUMMARY = { days: [{ date: '2026-11-24', ...SUM }], total: { ...SUM, by_model: [MODEL_LINE] } }
const WORKSPACE = { id: 'ws_01JCACME0000000000000000A1', name: 'Acme Outfitters', slug: 'acme', status: 'active', ...SUMMARY }
const FIRST_PAGE = {
  estimate: true, label: 'Estimate from list prices, not a bill', currency: 'USD', price_as_of: '2026-11-16',
  price_source: 'https://prices.example.com/', from: '2026-10-28', to: '2026-11-26', workspaces: [WORKSPACE],
  next_cursor: 'next-1',
  deployment: { ...SUMMARY, deleted_workspaces: { ...SUM, calls: 5, estimated_usd: null, complete: false, unpriced_models: ['model-beta'] } },
  unattributed: { days: [], total: { ...SUM, calls: 0, estimated_usd: '0.000000', by_model: [] } },
}

const RANGE = { from: '2026-10-28', to: '2026-11-26' }

describe('parseCostPage', () => {
  it('reads the first page: the estimate, each workspace, the deployment and the unattributed calls', () => {
    const page = parseCostPage(FIRST_PAGE)
    expect(page.meta).toStrictEqual({
      currency: 'USD', priceAsOf: '2026-11-16',
      priceSource: 'https://prices.example.com/', from: '2026-10-28', to: '2026-11-26',
    })
    expect([page.nextCursor, page.unreadable, page.unattributed?.total.estimated_usd]).toStrictEqual(['next-1', 0, '0.000000'])
    expect(page.rows).toStrictEqual([WORKSPACE])
    expect(page.deployment?.deleted_workspaces).toStrictEqual(FIRST_PAGE.deployment.deleted_workspaces)
  })

  it('keeps null as unpriced and reads a malformed figure as unpriced and incomplete, never as a number', () => {
    const page = parseCostPage({ ...FIRST_PAGE, workspaces: [
      { ...WORKSPACE, total: { ...SUMMARY.total, estimated_usd: null, complete: false, unpriced_models: ['model-beta'] } },
      { ...WORKSPACE, id: 'ws_2', total: { ...SUMMARY.total, estimated_usd: 0.75 } },
    ] })
    expect(page.rows.map((row) => [row.total.estimated_usd, row.total.complete])).toStrictEqual([[null, false], [null, false]])
    expect(page.rows[0]?.total.unpriced_models).toStrictEqual(['model-beta'])
  })

  it("marks a day whose figure is malformed incomplete, so its month is too (its dollars are not known)", () => {
    const page = parseCostPage({ ...FIRST_PAGE, workspaces: [
      { ...WORKSPACE, days: [{ date: '2026-11-24', ...SUM, estimated_usd: '1,25' }, { date: '2026-11-25', ...SUM }] },
    ] })
    expect(page.rows[0]?.days.map((day) => [day.estimated_usd, day.complete])).toStrictEqual([[null, false], ['0.750000', true]])
    expect(page.deployment?.total.complete).toBe(true)
  })

  it('drops a drifted workspace row, counts it, and reads a missing flag as incomplete', () => {
    const page = parseCostPage({ ...FIRST_PAGE, workspaces: [
      { ...WORKSPACE, total: { ...SUM, complete: 'yes' } },
      { name: 'No id', ...SUMMARY },
      { ...WORKSPACE, id: 'ws_3', total: 'junk' },
      { ...WORKSPACE, id: 'ws_4', days: [{ date: 'not a day', ...SUM }, { date: '2026-11-25', ...SUM }] },
    ] })
    expect(page.rows.map((row) => row.id)).toStrictEqual([WORKSPACE.id, 'ws_4'])
    expect(page.rows[0]?.total.complete).toBe(false)
    expect(page.rows[1]?.days.map((day) => day.date)).toStrictEqual(['2026-11-25'])
    expect(page.unreadable).toBe(2)
  })

  it('reads a later page without the deployment rows', () => {
    const page = parseCostPage({ ...FIRST_PAGE, deployment: undefined, unattributed: undefined, next_cursor: null })
    expect([page.deployment, page.unattributed, page.nextCursor]).toStrictEqual([null, null, null])
  })

  it.each([
    ['no answer', null],
    ['no workspaces list', { ...FIRST_PAGE, workspaces: undefined }],
    ['no range', { ...FIRST_PAGE, from: undefined }],
    ['a list with no estimate flag', { ...FIRST_PAGE, estimate: undefined }],
    // (a drifted cursor would end the paging silently, leaving the later workspaces out unsaid)
    ['a drifted next cursor', { ...FIRST_PAGE, next_cursor: 42 }],
    ['an empty next cursor', { ...FIRST_PAGE, next_cursor: '' }],
    ['no next cursor', { ...FIRST_PAGE, next_cursor: undefined }],
  ])('refuses %s: an error, never an empty page', (_name, raw) => {
    expect(() => parseCostPage(raw)).toThrow('The cost answer was unreadable')
  })

  it.each([
    ['its deployment row', { ...FIRST_PAGE, deployment: 'junk' }],
    ['its inactive workspaces part (missing)', { ...FIRST_PAGE, deployment: { ...SUMMARY } }],
    ['its inactive workspaces part (drifted)', { ...FIRST_PAGE, deployment: { ...SUMMARY, deleted_workspaces: 'junk' } }],
  ])("refuses a first page when %s cannot be read (the deployment's cost is never silently left out)", (_name, raw) => {
    expect(() => parseCostPage(raw, { firstPage: true })).toThrow('The cost answer was unreadable')
  })
})

describe('platformCostsApi.page', () => {
  it('asks for the range, and a later page by its cursor', async () => {
    routeFetchApi({
      'GET /platform/costs?from=2026-10-28&to=2026-11-26': () => FIRST_PAGE,
      'GET /platform/costs?from=2026-10-28&to=2026-11-26&cursor=next-1': () => ({ ...FIRST_PAGE, deployment: undefined, unattributed: undefined, next_cursor: null }),
    })
    await expect(platformCostsApi.page(RANGE, null)).resolves.toMatchObject({ nextCursor: 'next-1', rows: [WORKSPACE] })
    await expect(platformCostsApi.page(RANGE, 'next-1')).resolves.toMatchObject({ nextCursor: null, deployment: null })
    expect(fetchApi).toHaveBeenCalledTimes(2)
  })

  it('keys each range apart', () => {
    expect(platformCostsKey(RANGE)).toStrictEqual(['platform-costs', '2026-10-28', '2026-11-26'])
    expect(platformCostsKey({ ...RANGE, from: '2026-11-01' })).not.toStrictEqual(platformCostsKey(RANGE))
  })
})
