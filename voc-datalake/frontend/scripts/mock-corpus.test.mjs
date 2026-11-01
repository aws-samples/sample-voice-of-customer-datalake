#!/usr/bin/env node

/**
 * The dev mock's review list agrees with its metric fixtures, and its `dims` filter takes a
 * `key:a|b` list like the real route.
 *
 * - The corpus (mock-feedback-corpus.js) brings the list up to `GET /metrics/summary`'s total and
 *   matches `GET /metrics/categories` per category, `GET /metrics/sources` per source and the
 *   summary's urgent count, so a page never shows "1,247 reviews" over a list of three.
 * - Problem Analysis sends `dims=feedback_type:bug|service_failure|…|~unset` by default. The real
 *   `dimension_config._is_dims_value` checks each choice; the mock checked the whole list as one
 *   value and answered 400.
 *
 * Boots mock-server.js on a free port, like check-mock-coverage.mjs.
 * Run: node --test scripts/mock-corpus.test.mjs
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from './check-mock-coverage.mjs'
import { corpusFeedback } from '../mock-feedback-corpus.js'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..')
const START_TIMEOUT_MS = 20_000
const PAGE = 100

let child
let base

async function get(path) {
  const response = await fetch(`${base}${path}`)
  return [response.status, await response.json()]
}

/** Every review the list route returns for `query`, page by page. */
async function allFeedback(query = '') {
  const items = []
  for (let offset = 0; ; offset += PAGE) {
    const [status, body] = await get(`/feedback?days=0&limit=${PAGE}&offset=${offset}${query}`)
    assert.equal(status, 200)
    items.push(...body.items)
    if (body.items.length < PAGE) return items
  }
}

const countBy = (items, field) => items.reduce((acc, item) => ({ ...acc, [item[field]]: (acc[item[field]] ?? 0) + 1 }), {})

describe('dev mock: review corpus and dims lists', () => {
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

  it('lists as many reviews as the summary counts, per category, per source and urgent', async () => {
    const items = await allFeedback()
    const [, summary] = await get('/metrics/summary?days=7')
    const [, categories] = await get('/metrics/categories?days=7')
    const [, sources] = await get('/metrics/sources?days=7')
    assert.equal(items.length, summary.total_feedback)
    assert.deepEqual(countBy(items, 'category'), categories.categories)
    assert.deepEqual(countBy(items, 'source_platform'), sources.sources)
    assert.equal(items.filter((item) => item.urgency === 'high').length, summary.urgent_count)
  })

  it("accepts Problem Analysis's default dims list (longer than one value may be), and filters by any choice", async () => {
    const choices = ['bug', 'service_failure', 'performance', 'usability', 'pricing_billing', 'support_experience', '~unset']
    assert.ok(choices.join('|').length > 64, 'the list must be longer than one dimension value may be')
    const [status, body] = await get(`/feedback?days=0&limit=100&dims=${encodeURIComponent(`feedback_type:${choices.join('|')}`)}`)
    assert.equal(status, 200)
    assert.ok(body.items.length > 0)
    for (const item of body.items) {
      const type = item.dimensions?.feedback_type
      assert.ok(type === undefined || choices.includes(type), `unexpected type ${type}`)
    }
  })

  it('still refuses a malformed choice inside a dims list', async () => {
    const [status] = await get('/feedback?days=0&dims=feedback_type:bug%7Cbad%20value')
    assert.equal(status, 400)
  })
})

describe('corpusFeedback', () => {
  const handWritten = [{ feedback_id: '7', category: 'delivery', sentiment_label: 'negative', source_platform: 'web', urgency: 'high' }]
  const input = {
    categorySentiment: { delivery: { positive: 1, neutral: 0, negative: 3, mixed: 0 } },
    sourceCounts: { web: 2, app: 2 },
    urgentTotal: 2,
    handWritten,
    now: Date.UTC(2026, 0, 15),
  }

  it('generates only what the hand-written reviews leave, with ids after theirs', () => {
    const items = corpusFeedback(input)
    assert.equal(items.length, 3)
    assert.deepEqual(items.map((item) => item.feedback_id), ['8', '9', '10'])
    assert.deepEqual(countBy(items, 'sentiment_label'), { positive: 1, negative: 2 })
    assert.deepEqual(countBy([...handWritten, ...items], 'source_platform'), input.sourceCounts)
  })

  it('returns the same reviews for the same input', () => {
    assert.deepEqual(corpusFeedback(input), corpusFeedback(input))
  })
})
