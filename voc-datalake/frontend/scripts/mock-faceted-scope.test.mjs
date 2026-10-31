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
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..')
const START_TIMEOUT_MS = 20_000

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

let child
let base

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return [response.status, await response.json()]
}

describe('dev mock: faceted metric reads keep the caller scope', () => {
  before(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['mock-server.js'], { cwd: FRONTEND, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock server did not start')), START_TIMEOUT_MS)
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Mock API server running')) { clearTimeout(timer); resolve() }
      })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`mock server exited ${code}`)) })
    })
  })

  after(() => { child?.kill() })

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
