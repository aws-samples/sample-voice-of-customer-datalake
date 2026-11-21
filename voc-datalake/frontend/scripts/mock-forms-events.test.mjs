#!/usr/bin/env node

/**
 * The dev mock's funnel beacons take their own route, as the API does (docs/feedback-forms.md "The funnel"):
 * `POST /feedback-forms/{id}/events` counts an `opened` or a `left` (a form that is on, or a valid test link; a
 * malformed one is 400 `submission_invalid`), and the submit route takes responses only: a body with `event` is a 400
 * `submission_invalid` there. Its saves and Results answer as the handler does: every save counts one
 * (`write_count`, a stale `expected_write_count` is the 409), a removed question's id is never taken again, an answered
 * question keeps its type, and Results count the test responses either way and have no funnel under a language
 * filter. A rule whose op its question's type does not take is refused in the server's words
 * (schemas/form-logic-ops.json: a consent's `equals`, which the templates once wrote, is a 400 on a real
 * deployment). Boots mock-server.js on a free port.
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

describe("a rule's op, refused as the server refuses it (schemas/form-logic-ops.json)", () => {
  const consent = (logic) => ({ id: 'q_ok', type: 'consent', required: false, headline: { en: 'May we contact you?' }, label: { en: 'Yes' }, logic })
  const more = { id: 'q_more', type: 'open_text', required: false, headline: { en: 'Anything else?' }, long: true, input_type: 'text' }
  const body = (logic) => ({
    schema_version: 2, name: 'Consent rules', language: 'en', languages: ['en'], welcome: { enabled: false, title: {} },
    questions: [consent(logic), more], hidden_fields: [], endings: [{ id: 'end_thanks', title: { en: 'Thank you!' } }],
  })
  const toEnd = (when) => ({ when, then: { jump_to: 'end_thanks' } })

  it("refuses a consent's `equals` on a create and on a save, in the server's words", async () => {
    const [refused, created] = await call('POST', '/feedback-forms', body([toEnd({ op: 'equals', value: false })]))
    assert.deepStrictEqual([refused, created.error], [400, 'questions[0].logic[0].when.op must be one of skipped, submitted for a consent question'])
    const [status, saved] = await call('POST', '/feedback-forms', body([toEnd({ op: 'skipped' })]))
    assert.equal(status, 200)
    const [resaved, again] = await call('PUT', `/feedback-forms/${saved.form.form_id}`, body([toEnd({ op: 'submitted' }), toEnd({ op: 'equals', value: true })]))
    assert.deepStrictEqual([resaved, again.error], [400, 'questions[0].logic[1].when.op must be one of skipped, submitted for a consent question'])
  })

  it('refuses a value on an op that takes none, and an op another type takes', async () => {
    const [valued, withValue] = await call('POST', '/feedback-forms', body([toEnd({ op: 'skipped', value: false })]))
    assert.deepStrictEqual([valued, withValue.error], [400, 'questions[0].logic[0].when.value is not used by "skipped"'])
    const text = { ...body([]), questions: [{ ...more, logic: [toEnd({ op: 'gte', value: 3 })] }] }
    const [compared, refused] = await call('POST', '/feedback-forms', text)
    assert.deepStrictEqual([compared, refused.error], [400, 'questions[0].logic[0].when.op must be one of equals, not_equals, skipped, submitted for a open_text question'])
  })

  it("takes a consent's accepted and not accepted, and saves the seeded NPS form as it is", async () => {
    const [status] = await call('POST', '/feedback-forms', body([toEnd({ op: 'submitted' }), { when: { op: 'skipped' }, then: { jump_to: 'q_more' } }]))
    assert.equal(status, 200)
    const [, { form }] = await call('GET', '/feedback-forms/fv2_nps')
    assert.equal((await call('PUT', '/feedback-forms/fv2_nps', { schema_version: 2, questions: form.questions, endings: form.endings }))[0], 200)
  })
})
