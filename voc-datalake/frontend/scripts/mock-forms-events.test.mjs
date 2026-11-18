#!/usr/bin/env node

/**
 * The dev mock's funnel beacons take their own route, as the API does (docs/feedback-forms.md "The funnel"):
 * `POST /feedback-forms/{id}/events` counts an `opened` or a `left` (a form that is on, or a valid test link; a
 * malformed one is 400 `submission_invalid`), and the submit route takes responses only: a body with `event` is a 400
 * `submission_invalid` there. Boots mock-server.js on a free port.
 *
 * Run: node --test scripts/mock-forms-events.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()

const call = mockCaller(mock)

const SESSION = 'a1b2c3d4e5f6a1b2c3d4e5f6'
/** A live version 2 form of the seeds, and one that is Off. */
const LIVE = '/feedback-forms/fv2_old_ui'
const OFF = '/feedback-forms/fv2_nps'

describe('the funnel beacons (the events route)', () => {
  it('counts an opened and a left on a live form', async () => {
    const opened = await call('POST', `${LIVE}/events`, { event: { kind: 'opened', session: SESSION, revision: 4 } })
    const left = await call('POST', `${LIVE}/events`, { event: { kind: 'left', question_id: 'q_reason', session: SESSION } })
    assert.deepStrictEqual([opened, left], [[200, { success: true }], [200, { success: true }]])
  })

  it('refuses a malformed beacon with submission_invalid', async () => {
    const refused = await Promise.all([
      call('POST', `${LIVE}/events`, { event: { kind: 'step', session: SESSION } }),
      call('POST', `${LIVE}/events`, { event: { kind: 'left', session: SESSION } }),
      call('POST', `${LIVE}/events`, { event: { kind: 'opened', session: 'short' } }),
      call('POST', `${LIVE}/events`, { event: { kind: 'opened', session: SESSION }, answers: {} }),
    ])
    assert.deepStrictEqual(refused.map(([status, body]) => [status, body.code]), Array(4).fill([400, 'submission_invalid']))
  })

  it('refuses a beacon for a form that is Off without a test link', async () => {
    const [status, body] = await call('POST', `${OFF}/events`, { event: { kind: 'opened', session: SESSION } })
    assert.deepStrictEqual([status, body.code], [400, 'form_off'])
  })

  it('is never taken by the submit route', async () => {
    const [status, body] = await call('POST', `${LIVE}/submit`, { event: { kind: 'opened', session: SESSION } })
    assert.deepStrictEqual([status, body.code], [400, 'submission_invalid'])
  })
})
