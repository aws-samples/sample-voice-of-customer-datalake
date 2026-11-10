#!/usr/bin/env node

/**
 * Tests for the dev mock's caller scope (mock-scope.js): what a restricted mock
 * caller receives from GET /feedback/access, GET /settings/categories and the
 * metric reads, and the runtime PUT /__mock/scope switch. It calls mock-scope.js's
 * helpers directly and starts no server (the server-booting specs use mock-server-harness.mjs).
 *
 * Run: node --test scripts/mock-scope.test.mjs
 */

import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'
import {
  callerAccess, handleScopeRoutes, isScopeRestricted, scopeAdmits, scopedCategoriesConfig, scopedMetric,
} from '../mock-scope.js'

const CATEGORY_COUNTS = { delivery: 300, customer_support: 100 }
const CONFIG = { categories: [{ name: 'delivery' }, { name: 'customer_support' }, { name: 'technical_support' }] }

/** Drive PUT|GET /__mock/scope the way mock-server.js does; resolves with [status, body]. */
function route(method, body) {
  return new Promise((resolve) => {
    const shared = { collectJson: (_req, _res, done) => done(body) }
    const handled = handleScopeRoutes({ method }, {}, new URL('https://mock/__mock/scope'), (...reply) => resolve(reply), shared)
    assert.equal(handled, true)
  })
}

const restrictTo = (categories) => route('PUT', { categories })

describe('mock caller scope', () => {
  beforeEach(() => restrictTo(null))

  it('is unrestricted by default: an admin-shaped access body and every category', async () => {
    assert.deepEqual([isScopeRestricted(), callerAccess().all, callerAccess().source_rule], [false, true, 'all'])
    assert.equal(scopedCategoriesConfig(CONFIG), CONFIG)
  })

  it('answers a restricted caller like the real route answers a viewer', async () => {
    await restrictTo(['customer_support'])
    assert.deepEqual(callerAccess(), {
      all: false, categories: ['customer_support'], sources_all: false, sources: [], source_rule: 'deny', sources_denied: [],
    })
    assert.deepEqual(scopedCategoriesConfig(CONFIG).categories, [{ name: 'customer_support' }])
    assert.deepEqual([scopeAdmits('customer_support'), scopeAdmits('delivery')], [true, false])
  })

  it('keeps only the allowed category counters and scales totals to their share', async () => {
    await restrictTo(['customer_support'])
    const ctx = { categoryCounts: CATEGORY_COUNTS, searchParams: new URLSearchParams() }
    const categories = scopedMetric('GET /metrics/categories', { categories: CATEGORY_COUNTS }, ctx)
    const summary = scopedMetric('GET /metrics/summary', { total_feedback: 400, urgent_count: 8, daily_totals: [{ date: 'd', count: 40 }] }, ctx)
    assert.deepEqual(categories.categories, { customer_support: 100 })
    assert.deepEqual([summary.total_feedback, summary.urgent_count, summary.daily_totals[0].count], [100, 2, 10])
  })

  it('gives a caller whose categories have no reviews an empty summary', async () => {
    await restrictTo(['technical_support'])
    const ctx = { categoryCounts: CATEGORY_COUNTS, searchParams: new URLSearchParams() }
    const summary = scopedMetric('GET /metrics/summary', { total_feedback: 400, urgent_count: 8, daily_totals: [{ date: 'd', count: 40 }] }, ctx)
    assert.deepEqual([summary.total_feedback, summary.daily_totals], [0, []])
  })

  it('zeroes a sentiment read for a category outside the scope', async () => {
    await restrictTo(['customer_support'])
    const ctx = { categoryCounts: CATEGORY_COUNTS, searchParams: new URLSearchParams('category=delivery') }
    const sentiment = scopedMetric('GET /metrics/sentiment', { breakdown: { positive: 5, negative: 3 } }, ctx)
    assert.equal(sentiment.total, 0)
  })

  it('scales a sentiment breakdown so its buckets still add up to the scaled total', async () => {
    await restrictTo(['customer_support'])
    // share 245 / 1247, like the dev fixtures: plain rounding gave 246 buckets for 245 reviews.
    const ctx = { categoryCounts: { customer_support: 245, delivery: 1002 }, searchParams: new URLSearchParams() }
    const sentiment = scopedMetric('GET /metrics/sentiment', { breakdown: { positive: 523, neutral: 387, negative: 298, mixed: 39 } }, ctx)
    assert.equal(sentiment.total, 245)
  })

  it('reads the switch back, accepts [] (no category) and refuses a malformed body', async () => {
    assert.deepEqual(await restrictTo([]), [200, { categories: [] }])
    assert.deepEqual(await route('GET'), [200, { categories: [] }])
    const [status] = await route('PUT', { categories: 'delivery' })
    assert.equal(status, 400)
  })
})
