/**
 * @fileoverview The board Insights boundary: each call hits its own route with its own query, and a
 * malformed answer degrades field by field (never throws), so the Insights tab cannot blank.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const { fetchApi, resetFetchApi } = await import('@test/fetchApiRoutes')
const { enrichFeatureRequests, getFeatureRequestInsights, isInsightWindow } = await import('./featureRequestInsights')
const { enrichmentSchema } = await import('./featureRequestInsightsSchema')

const INSIGHTS = {
  success: true,
  board: { id: 'brd_sales', label: 'Sales feature requests' },
  window_days: 90,
  totals: { requests: 3, supporters: 5, enriched: 2 },
  top: [{ request_id: 'fr_1', board_id: 'brd_sales', title: 'SSO', status: 'new', supporters: 3, category: 'login' }],
  by_category: [{ category: 'login', requests: 2, supporters: 4 }, { category: 'uncategorized', requests: 1, supporters: 1 }],
  by_status: [{ status: 'new', requests: 3, supporters: 5 }],
  by_sentiment: [{ sentiment: 'negative', requests: 2 }, { sentiment: null, requests: 1 }],
}

beforeEach(() => resetFetchApi())

describe('getFeatureRequestInsights', () => {
  it('asks for one board and window', async () => {
    fetchApi.mockResolvedValue(INSIGHTS)
    await getFeatureRequestInsights({ board: 'brd_sales', days: 90 })
    expect(fetchApi).toHaveBeenCalledWith('/feature-requests/insights?days=90&board=brd_sales', undefined)
  })

  it('leaves the board out for every board', async () => {
    fetchApi.mockResolvedValue(INSIGHTS)
    await getFeatureRequestInsights({ days: 0 })
    expect(fetchApi).toHaveBeenCalledWith('/feature-requests/insights?days=0', undefined)
  })

  it('reads a well-formed answer, an uncategorized row as no category', async () => {
    fetchApi.mockResolvedValue(INSIGHTS)
    const insights = await getFeatureRequestInsights({ days: 90 })
    expect(insights.totals).toStrictEqual({ requests: 3, supporters: 5, enriched: 2 })
    expect(insights.by_category.map((row) => row.category)).toStrictEqual(['login', null])
    expect(insights.board).toStrictEqual({ id: 'brd_sales', label: 'Sales feature requests' })
    expect(insights.truncated).toBe(false)
  })

  it('reads a truncated answer and every board as board null', async () => {
    fetchApi.mockResolvedValue({ ...INSIGHTS, board: null, truncated: true })
    const insights = await getFeatureRequestInsights({ days: 0 })
    expect(insights.truncated).toBe(true)
    expect(insights.board).toBeNull()
  })

  it("adds the 'unknown' sentiment bucket to the not-enriched one", async () => {
    fetchApi.mockResolvedValue({
      ...INSIGHTS,
      by_sentiment: [{ sentiment: 'negative', requests: 2 }, { sentiment: 'unknown', requests: 3 }, { sentiment: null, requests: 1 }],
    })
    const insights = await getFeatureRequestInsights({ days: 90 })
    expect(insights.by_sentiment).toStrictEqual([{ sentiment: 'negative', requests: 2 }, { sentiment: null, requests: 4 }])
  })

  it.each([[null], ['nope'], [{ totals: 'x', top: 'y', board: 7 }]])('reads %j as empty insights', async (raw) => {
    fetchApi.mockResolvedValue(raw)
    const insights = await getFeatureRequestInsights({ days: 30 })
    expect(insights).toStrictEqual({
      board: null, window_days: 0, totals: { requests: 0, supporters: 0, enriched: 0 }, truncated: false,
      top: [], by_category: [], by_status: [], by_sentiment: [],
    })
  })

  it('drops a malformed top row and keeps the rest', async () => {
    fetchApi.mockResolvedValue({ ...INSIGHTS, top: [{ title: 'no id' }, ...INSIGHTS.top] })
    const insights = await getFeatureRequestInsights({ days: 90 })
    expect(insights.top.map((row) => row.request_id)).toStrictEqual(['fr_1'])
  })
})

describe('enrichFeatureRequests', () => {
  it('posts the board and reads the queue counts', async () => {
    fetchApi.mockResolvedValue({ success: true, queued: 4, remaining: 10 })
    await expect(enrichFeatureRequests('brd_sales')).resolves.toStrictEqual({ queued: 4, remaining: 10 })
    expect(fetchApi.mock.calls[0]?.[0]).toBe('/feature-requests/insights/enrich')
    expect(fetchApi.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ board: 'brd_sales' }) })
  })

  it('posts an empty body for every board, and reads junk as nothing queued', async () => {
    fetchApi.mockResolvedValue('junk')
    await expect(enrichFeatureRequests()).resolves.toStrictEqual({ queued: 0, remaining: 0 })
    expect(fetchApi.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({}) })
  })
})

describe('isInsightWindow', () => {
  it.each([30, 90, 365, 0])('accepts %i', (days) => {
    expect(isInsightWindow(days)).toBe(true)
  })

  it.each([7, -1, 3651])('refuses %i', (days) => {
    expect(isInsightWindow(days)).toBe(false)
  })
})

describe('enrichmentSchema', () => {
  it('reads an enrichment, an unknown sentiment as none', () => {
    expect(enrichmentSchema.parse({ status: 'ok', category: 'login', sentiment: 'angry', enriched_at: 'x' })).toStrictEqual({
      status: 'ok', category: 'login', subcategory: null, sentiment: null, problem_summary: null, enriched_at: 'x',
    })
  })

  it.each([[undefined], ['x'], [42]])('reads %j as not enriched', (raw) => {
    expect(enrichmentSchema.parse(raw)).toBeUndefined()
  })
})
