/**
 * The learned review-site methods client: the wire paths of integrations_handler.py, the lenient read of the list,
 * and the clear's answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { readWebReviewMethods, webReviewMethodsApi } from './webReviewMethodsApi'

const STATS = { last_outcome: 'readable', last_at: '2026-11-01T09:00:00Z', successes: 2, failures: 0, last_reviews: 11 }
const LEARNED = {
  domain: 'example-reviews.com', best_method: 'bedrock_web_search', learned_at: '2026-11-01T09:00:00Z',
  browser_recheck_due_at: '2026-11-15T09:00:00Z', methods: { bedrock_web_search: STATS },
}

beforeEach(() => resetFetchApi())

describe('readWebReviewMethods', () => {
  it("keeps the readable records in the server's order", () => {
    const none = { domain: 'other.example', best_method: 'none', learned_at: null, browser_recheck_due_at: null, methods: {} }
    expect(readWebReviewMethods({ methods: [LEARNED, none] })).toStrictEqual([LEARNED, none])
  })

  it('leaves out a record without a domain; an unknown best method reads as none, a bad or missing time as none', () => {
    const older = { domain: LEARNED.domain, best_method: 'curl', learned_at: 7, methods: LEARNED.methods }
    const rows = [{ domain: '', best_method: 'browser' }, 'junk', older]
    expect(readWebReviewMethods({ methods: rows })).toStrictEqual([
      { ...LEARNED, best_method: 'none', learned_at: null, browser_recheck_due_at: null }])
  })

  it("drops a method this build does not know, or stats it cannot read, keeping the others", () => {
    const methods = { bedrock_web_search: STATS, telnet: STATS, browser: 'blocked' }
    expect(readWebReviewMethods({ methods: [{ ...LEARNED, methods }] })).toStrictEqual([LEARNED])
  })

  it.each([[null], [{}], [{ methods: 'none' }]])('reads %j as no record', (raw) => {
    expect(readWebReviewMethods(raw)).toStrictEqual([])
  })
})

describe('webReviewMethodsApi', () => {
  it('lists GET /integrations/web_reviews/methods', async () => {
    routeFetchApi({ 'GET /integrations/web_reviews/methods': () => ({ methods: [LEARNED] }) })
    await expect(webReviewMethodsApi.list()).resolves.toStrictEqual([LEARNED])
  })

  it('clears one site with DELETE …/methods/{domain}, the domain encoded, and answers whether there was a record', async () => {
    routeFetchApi({ 'DELETE /integrations/web_reviews/methods/a%2Fb.example': () => ({ success: true, domain: 'a/b.example', cleared: true }) })
    await expect(webReviewMethodsApi.clear('a/b.example')).resolves.toStrictEqual({ success: true, domain: 'a/b.example', cleared: true })
    expect(fetchApi).toHaveBeenCalledWith('/integrations/web_reviews/methods/a%2Fb.example', { method: 'DELETE' })
  })
})
