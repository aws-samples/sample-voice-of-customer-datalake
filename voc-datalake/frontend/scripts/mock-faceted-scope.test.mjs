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
    const [, all] = await call('GET', '/metrics/categories?days=0&sentiment=positive,negative')
    const names = Object.keys(all.categories ?? {})
    assert.ok(names.length >= 2, 'the fixtures span several categories')
    const [allowed] = names
    const [status] = await call('PUT', '/__mock/scope', { categories: [allowed] })
    assert.equal(status, 200)
    try {
      const [, scoped] = await call('GET', '/metrics/categories?days=0&sentiment=positive,negative')
      assert.deepEqual(Object.keys(scoped.categories ?? {}), [allowed])
      const ceiling = all.categories[allowed]
      const [, summary] = await call('GET', '/metrics/summary?days=0&sentiment=positive,negative')
      assert.ok(summary.total_feedback <= ceiling, 'the summary total covers the allowed category only')
      const [, sentiment] = await call('GET', '/metrics/sentiment?days=0&sentiment=positive,negative')
      assert.ok(sentiment.total <= ceiling, 'the sentiment total covers the allowed category only')
      const [, sources] = await call('GET', '/metrics/sources?days=0&sentiment=positive,negative')
      const sourceTotal = Object.values(sources.sources ?? {}).reduce((sum, n) => sum + Number(n), 0)
      assert.ok(sourceTotal <= ceiling, 'the per-source counts cover the allowed category only')
    } finally {
      await call('PUT', '/__mock/scope', { categories: null })
    }
  })
})
