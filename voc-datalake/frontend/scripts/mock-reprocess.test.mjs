#!/usr/bin/env node

/**
 * The dev mock's `POST /settings/categories/reprocess {resume}` answers in the route's order
 * (settings_handler `_resume_reprocess`): the body (400), the job (404), its state (409), and only then
 * another active job (409, the route's wording). Boots mock-server.js on a free port.
 *
 * Run: node --test scripts/mock-reprocess.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()

async function reprocess(body) {
  const response = await fetch(`${mock.base}/settings/categories/reprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return [response.status, (await response.json()).error]
}

describe('dev mock: a resume is checked in the route order', () => {
  it('refuses a malformed or unknown resume before reporting the running job', async () => {
    const [started] = await reprocess({ mode: 'processed', days: 7 })
    assert.equal(started, 202)

    assert.deepEqual(await reprocess({ resume: 'not-a-job' }), [400, 'resume must be a reprocess job id'])
    assert.deepEqual(await reprocess({ resume: 'rp_000000000000' }), [404, 'Reprocess job not found'])
    assert.deepEqual(await reprocess({ resume: 'rp_000000000000', mode: 'raw' }),
      [400, 'resume takes no other fields: the resumed job keeps its mode and slice'])
    assert.deepEqual(await reprocess({ mode: 'raw', days: 7 }), [409, 'A reprocess job is already queued or running'])
  })
})
