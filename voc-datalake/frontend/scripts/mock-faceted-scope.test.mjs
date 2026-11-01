#!/usr/bin/env node

/**
 * The dev mock's faceted metric reads honour the caller's category scope: with a facet set
 * (`/metrics/categories?source=a,b`), the mock counts its filtered fixtures, and a restricted
 * caller must never see counts for a category outside its scope (docs/categories.md: access is
 * applied after these filters). The route wrapper's `scopedMetric` (mock-server.js) applies the
 * scope to every metric answer, faceted ones included; this pins that. Boots mock-server.js on a
 * free port, like check-mock-coverage.mjs.
 *
 * Run: node --test scripts/mock-faceted-scope.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()

async function call(method, path, body) {
  const response = await fetch(`${mock.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return [response.status, await response.json()]
}

describe('dev mock: faceted metric reads keep the caller scope', () => {
  it('counts only the allowed categories when a facet is set', async () => {
    const FACET = 'days=0&sentiment=positive,negative'
    const totals = async () => {
      const [, summary] = await call('GET', `/metrics/summary?${FACET}`)
      const [, sentiment] = await call('GET', `/metrics/sentiment?${FACET}`)
      const [, sources] = await call('GET', `/metrics/sources?${FACET}`)
      const sourceTotal = Object.values(sources.sources ?? {}).reduce((sum, n) => sum + Number(n), 0)
      return { summary: summary.total_feedback, sentiment: sentiment.total, sources: sourceTotal }
    }
    const [, all] = await call('GET', `/metrics/categories?${FACET}`)
    const names = Object.keys(all.categories ?? {}).filter((name) => all.categories[name] > 0)
    assert.ok(names.length >= 2, 'the faceted fixtures span several categories')
    const [allowed] = names
    const unscoped = await totals()
    const [status] = await call('PUT', '/__mock/scope', { categories: [allowed] })
    assert.equal(status, 200)
    try {
      const [, scopedCategories] = await call('GET', `/metrics/categories?${FACET}`)
      assert.deepEqual(Object.keys(scopedCategories.categories ?? {}), [allowed])
      const scoped = await totals()
      // A leak would answer the unscoped number: every scoped total is strictly smaller, and none exceeds
      // the allowed category's own count.
      for (const key of ['summary', 'sentiment', 'sources']) {
        assert.ok(scoped[key] < unscoped[key], `${key}: ${scoped[key]} < ${unscoped[key]}`)
        assert.ok(scoped[key] <= all.categories[allowed], `${key} covers the allowed category only`)
      }
    } finally {
      await call('PUT', '/__mock/scope', { categories: null })
    }
  })
})
