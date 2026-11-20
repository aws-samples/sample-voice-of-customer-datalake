#!/usr/bin/env node

/**
 * The dev mock's funnel beacons take their own route, as the API does (docs/feedback-forms.md "The funnel"):
 * `POST /feedback-forms/{id}/events` counts an `opened` or a `left` (a form that is on, or a valid test link; a
 * malformed one is 400 `submission_invalid`), and the submit route takes responses only: a body with `event` is a 400
 * `submission_invalid` there. Its saves and Results answer as the handler does (7.58.00): every save counts one
 * (`write_count`, a stale `expected_write_count` is the 409), a removed question's id is never taken again, an answered
 * question keeps its type, and Results count the test responses either way and have no funnel under a language
 * filter. Boots mock-server.js on a free port.
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

describe('the saves and Results (as the handler answers them)', () => {
  const NPS_FORM = '/feedback-forms/fv2_nps'
  const read = async () => (await call('GET', NPS_FORM))[1].form

  it('counts every save and refuses a stale one, the revision moving with the definition only', async () => {
    const before = await read()
    const [status, saved] = await call('PUT', NPS_FORM, { name: 'Renamed', expected_write_count: before.write_count })
    assert.deepStrictEqual([status, saved.form.revision, saved.form.write_count], [200, before.revision, before.write_count + 1])
    const [stale, refused] = await call('PUT', NPS_FORM, { enabled: true, expected_write_count: before.write_count })
    assert.deepStrictEqual([stale, refused.code, refused.write_count], [409, 'revision_conflict', before.write_count + 1])
    assert.equal((await read()).enabled, false)
  })

  it("keeps an answered question's type, and never gives a removed question's id back", async () => {
    const form = await read()
    const asCsat = form.questions.map((q) => (q.id === 'q_nps' ? { ...q, type: 'csat', logic: undefined } : q))
    const [locked, body] = await call('PUT', NPS_FORM, { schema_version: 2, questions: asCsat, endings: form.endings })
    assert.deepStrictEqual([locked, body.code, body.changed], [409, 'answers_locked', ['q_nps']])
    const kept = form.questions.filter((q) => q.id !== 'q_passive_improve')
    const [removed, saved] = await call('PUT', NPS_FORM, { schema_version: 2, questions: kept, endings: form.endings, removes: { questions: ['q_passive_improve'] } })
    assert.deepStrictEqual([removed, saved.form.retired_ids, saved.form.revision], [200, ['q_passive_improve'], form.revision + 1])
    const [reused, refused] = await call('PUT', NPS_FORM, { schema_version: 2, questions: form.questions, endings: form.endings })
    assert.deepStrictEqual([reused, refused.code, refused.question_id], [400, 'question_id_reused', 'q_passive_improve'])
  })

  it('counts the test responses whether or not they are included, and has no funnel under a language filter', async () => {
    const [, link] = await call('POST', `${LIVE}/test-link`, {})
    const [tagged] = await call('POST', `${LIVE}/submit`, { answers: { q_why: { codes: ['errors'] }, q_return: { code: 'not_sure' } }, test: link.test.token })
    assert.equal(tagged, 200)
    const [, plain] = await call('GET', `${LIVE}/results`)
    const [, included] = await call('GET', `${LIVE}/results?include_test=true`)
    const [, filtered] = await call('GET', `${LIVE}/results?language=pl`)
    assert.ok(plain.test_responses > 0)
    assert.equal(plain.test_responses, included.test_responses)
    assert.equal(included.responses, plain.responses + plain.test_responses)
    assert.deepStrictEqual([plain.funnel === null, filtered.funnel], [false, null])
  })
})
