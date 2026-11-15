#!/usr/bin/env node

/**
 * The dev mock mirrors the API on three points the e2e suite leans on (docs/document-review.md
 * "Saving a proposal", metrics_handler.list_feedback, mock-feature-requests.js's viewers):
 *
 * - a document save names its "Revise from comments" pass (`revise_job_id`) and is recorded as a
 *   revise only when the pass checks out (this project's, a completed proposal, the same caller, the
 *   same series, a change NEW in the text: an `after` more often than in the edited version, or a `before`
 *   less often while its `after` stays: a deletion or a trim), else 400 with the code `revise_refused`; a client's own `edit_kind` is ignored
 *   like any unknown key; a later save never inherits `edited_by` / `revise_job_id` (ROW_IDENTITY);
 * - marking threads addressed past a thread's history cap answers 409, with the machine-readable `code`
 *   `addressed_some_full` when the others were marked;
 * - `GET /feedback` lists the newest import first, so a just-uploaded CSV row is on the first page;
 * - `x-mock-board-viewer: user` is a second, non-admin app user whose +1 is its own.
 *
 * Boots mock-server.js on a free port. Run: node --test scripts/mock-document-revise.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'
import { holdsAChange } from '../mock-project-actions.js'

// The pass's outcome, read by the mock when it starts (the harness hands the env to its process).
process.env.MOCK_REVISE_OUTCOME = 'proposal'

const mock = useMockServer()
const call = mockCaller(mock)

/** `call` with the feature-request viewer header. */
async function callAs(viewer, method, path, body) {
  const response = await fetch(`${mock.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-mock-board-viewer': viewer },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return [response.status, await response.json()]
}

/** The head (highest version) of proj_1's `type` series. */
async function seriesHead(type) {
  const [, detail] = await call('GET', '/projects/proj_1')
  return detail.documents.filter((d) => d.document_type === type).sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0]
}

/** A completed proposal pass on `doc`: its job id and its changes. */
async function proposalOn(doc) {
  const [started, body] = await call('POST', `/projects/proj_1/documents/${doc.document_id}/revise-from-comments`, {})
  assert.equal(started, 202, JSON.stringify(body))
  const [, job] = await call('GET', `/projects/proj_1/jobs/${body.job_id}`)
  assert.equal(job.status, 'completed')
  assert.equal(job.result.outcome, 'proposal')
  assert.ok(job.result.changes.length > 0, 'the seeded threads give the pass a change')
  assert.deepEqual([job.result.model_id, job.result.prompt_version], ['global.anthropic.claude-sonnet-5-5', '1.0.0'])
  return { jobId: body.job_id, changes: job.result.changes }
}

const applied = (content, changes) => changes.reduce((text, change) => text.replace(change.before, change.after), content)
const put = (doc, body) => call('PUT', `/projects/proj_1/documents/${doc.document_id}`, body)

describe('dev mock: a saved proposal is a revise only when the server checks its pass', () => {
  it('records a checked save as a revise by the person with its pass, and a later save inherits neither', async () => {
    const head = await seriesHead('prd')
    const { jobId, changes } = await proposalOn(head)

    const [status, saved] = await put(head, { content: applied(head.content, changes), revise_job_id: jobId, edit_id: 'rev1' })
    assert.equal(status, 200, JSON.stringify(saved))
    assert.equal(saved.document.edit_kind, 'revise')
    assert.equal(saved.document.revise_job_id, jobId)
    assert.deepEqual(saved.document.edited_by, { sub: 'sub-admin-demo', kind: 'user' })
    const llm = { model: 'global.anthropic.claude-sonnet-5-5', prompt_version: '1.0.0' }
    assert.deepEqual(saved.document.llm_metadata, llm)

    const [later, plain] = await put(saved.document, { content: `${saved.document.content}\n\nOne more line.`, edit_id: 'rev2' })
    assert.equal(later, 200, JSON.stringify(plain))
    assert.equal(plain.document.edit_kind, 'edit')
    assert.equal(plain.document.edited_by, undefined)
    assert.equal(plain.document.revise_job_id, undefined)
    assert.equal(plain.document.llm_metadata, undefined)

    const [, listed] = await call('GET', `/projects/proj_1/documents/${plain.document.document_id}/versions`)
    assert.deepEqual(listed.versions.slice(0, 2).map((v) => v.llm_metadata), [null, { ...llm, model_label: 'Claude Sonnet 5.5' }])
  })

  it('refuses a save without any of the changes, of another series, or of an unknown pass, and writes nothing', async () => {
    const prfaq = await seriesHead('prfaq')
    const { jobId, changes } = await proposalOn(prfaq)
    const head = await seriesHead('prd')
    const cases = [
      [prfaq, { content: 'My own words, none of the changes.', revise_job_id: jobId }, 'This save does not hold a change from that revision', 'revise_refused'],
      [head, { content: applied(head.content, changes) + changes[0].after, revise_job_id: jobId }, 'That revision is of another document', 'revise_refused'],
      [head, { content: `${head.content}\n\nx`, revise_job_id: 'job_unknown' }, 'That revision was not found in this project', 'revise_refused'],
      // A malformed id is the body's 400, not a refused revise: no code.
      [head, { content: 'x', revise_job_id: 'not an id!' }, 'revise_job_id must be the job id of a Revise from comments pass', undefined],
    ]
    for (const [doc, body, message, code] of cases) {
      const [status, answer] = await put(doc, body)
      assert.equal(status, 400, message)
      assert.ok(String(answer.error).includes(message), `${message}: ${answer.error}`)
      assert.equal(answer.code, code, message)
    }
    assert.equal((await seriesHead('prd')).document_id, head.document_id, 'nothing was written')
    assert.equal((await seriesHead('prfaq')).document_id, prfaq.document_id, 'nothing was written')
  })

  it('refuses a pass that has not finished yet (no proposal to save)', async () => {
    const head = await seriesHead('prd')
    const [, started] = await call('POST', `/projects/proj_1/documents/${head.document_id}/revise-from-comments`, {})
    const [status, answer] = await put(head, { content: `${head.content}\n\nx`, revise_job_id: started.job_id })
    assert.deepEqual([status, answer.code], [400, 'revise_refused'])
    assert.match(answer.error, /has no proposal to save/)
  })

  it('refuses a save whose change was already in the document (nothing else of the pass in it)', async () => {
    const prfaq = await seriesHead('prfaq')
    const { jobId, changes } = await proposalOn(prfaq)
    const withAfter = applied(prfaq.content, changes)
    const [first, saved] = await put(prfaq, { content: withAfter, edit_id: 'plain1' })
    assert.equal(first, 200, JSON.stringify(saved))

    const [status, answer] = await put(saved.document, { content: `${withAfter}\n\nA line of mine.`, revise_job_id: jobId })
    assert.equal(status, 400)
    assert.match(answer.error, /does not hold a change from that revision/)
  })

  it('answers an unchanged save naming a pass with the no-op, whether the pass checks out or not', async () => {
    const head = await seriesHead('prd')
    for (const jobId of ['job_unknown', (await proposalOn(head)).jobId]) {
      const [status, answer] = await put(head, { content: head.content, revise_job_id: jobId })
      assert.equal(status, 200, JSON.stringify(answer))
      assert.equal(answer.unchanged, true)
      assert.equal(answer.document.document_id, head.document_id)
    }
    assert.equal((await seriesHead('prd')).document_id, head.document_id, 'nothing was written')
  })

  it('ignores a client\'s own edit_kind, like any other key it does not read: the save is a plain edit', async () => {
    for (const [index, kind] of ['revise', 'restore', 'edit'].entries()) {
      const head = await seriesHead('prfaq')
      const [status, saved] = await put(head, { content: `${head.content}\n\nA client saying ${kind}.`, edit_kind: kind, edit_id: `kind${index}` })
      assert.equal(status, 200, JSON.stringify(saved))
      assert.equal(saved.document.edit_kind, 'edit')
      assert.equal(saved.document.revise_job_id, undefined)
    }
  })
})

describe('dev mock: which changes a save holds (document_revision.holds_a_change)', () => {
  const edited = 'It costs ten dollars. Or eight dollars.'
  it('holds a deletion whose before is gone, verbatim and as plain text', () => {
    assert.equal(holdsAChange('It costs dollars. Or eight dollars.', edited, [{ before: 'ten ', after: '' }]), true)
    assert.equal(holdsAChange('It costs **ten** dollars. Or eight dollars.', edited, [{ before: 'ten ', after: '' }]), false)
    assert.equal(holdsAChange(edited, edited, [{ before: 'ten ', after: '' }]), false)
    assert.equal(holdsAChange('It costs dollars.', edited, [{ before: 'nine ', after: '' }]), false)
  })
  it('holds an after only when it occurs more often than in the edited text', () => {
    assert.equal(holdsAChange(`${edited} More.`, edited, [{ before: 'ten dollars', after: 'eight dollars' }]), false)
    assert.equal(holdsAChange('It costs eight dollars. Or eight dollars.', edited, [{ before: 'ten dollars', after: 'eight dollars' }]), true)
    assert.equal(holdsAChange('It costs **eight** dollars. Or eight dollars.', edited, [{ before: 'ten dollars', after: 'eight dollars' }]), true)
  })
  it('holds a trim (its after a piece of its before) when the before is gone and the after stays', () => {
    const long = 'Reminders go out at most once a day per parcel.'
    const atEnd = { before: 'at most once a day per parcel', after: 'at most once a day' }
    const atStart = { before: 'at most once a day per parcel', after: 'once a day per parcel' }
    assert.equal(holdsAChange('Reminders go out at most once a day.', long, [atEnd]), true)
    assert.equal(holdsAChange('Reminders go out once a day per parcel.', long, [atStart]), true)
    assert.equal(holdsAChange('Reminders go out at most **once a day**.', long, [atEnd]), true)
    assert.equal(holdsAChange(long, long, [atEnd]), false, 'not applied: the after inside the before is not new')
    assert.equal(holdsAChange('Reminders go out.', long, [atEnd]), false, 'deleted, not trimmed')
    assert.equal(holdsAChange('Reminders go out weekly.', long, [{ ...atEnd, after: 'twice a week' }]), false)
    const rewrite = { before: 'Second draft', after: 'the launch' }
    assert.equal(holdsAChange('My own words of the launch.', 'Second draft of the launch.', [rewrite]), false,
      'a hand rewrite: the after was already elsewhere and is not a piece of the before')
  })
  it('compares plain text as the API does: headings, list markers, links and images go, their words stay', () => {
    const page = 'Intro.'
    const change = { before: 'Intro.', after: 'See the [price list](https://example.com/prices) and ![the chart](c.png).' }
    assert.equal(holdsAChange('## See the price list and the chart.\n\nIntro.', page, [change]), true)
    assert.equal(holdsAChange('- See the [price list](/p) and the chart.\n\nIntro.', page, [change]), true)
    // A single `_` is not emphasis to the API (only `*`): the words differ.
    assert.equal(holdsAChange('See the _price list_ and the chart.\n\nIntro.', page, [change]), false)
    assert.equal(holdsAChange('See the *price list* and the chart.\n\nIntro.', page, [change]), true)
  })
})

describe('dev mock: marking threads addressed past a thread\'s history cap', () => {
  it('marks the others, then answers 409 with the code', async () => {
    const head = await seriesHead('prd')
    const path = `/projects/proj_1/documents/${head.document_id}/comments`
    const make = async (text) => {
      const [created, body] = await call('POST', path, { text })
      assert.equal(created, 200, JSON.stringify(body))
      return body.thread.comment_id
    }
    const [full, other] = [await make('Fill my history.'), await make('Mark me.')]
    for (let n = 0; n < 100; n += 1) {
      const [status] = await call('POST', `${path}/addressed`, { thread_ids: [full], addressed: n % 2 === 0 })
      assert.equal(status, 200)
    }
    const [none, alone] = await call('POST', `${path}/addressed`, { thread_ids: [full] })
    assert.deepEqual([none, alone.code], [409, undefined], 'none marked: no code')

    const [status, answer] = await call('POST', `${path}/addressed`, { thread_ids: [full, other] })
    assert.deepEqual([status, Object.keys(answer).sort(), answer.code], [409, ['code', 'error', 'success'], 'addressed_some_full'])
  })
})

describe('dev mock: GET /feedback lists the newest import first', () => {
  it('orders by processed_at, newest first, so a just-uploaded CSV row is on the first page', async () => {
    const stamp = Date.now()
    const csv = `id,text,date\n1,Fresh upload ${stamp},2026-01-10\n`
    const [uploaded, answer] = await call('POST', '/scrapers/manual/csv-upload', { csv_text: csv, dataset_name: `Order ${stamp}` })
    assert.equal(uploaded, 200, JSON.stringify(answer))
    const [, list] = await call('GET', '/feedback?days=0&limit=5')
    assert.ok(list.items.some((item) => item.original_text === `Fresh upload ${stamp}`), 'the new row is on the first page')
    const [, all] = await call('GET', '/feedback?days=0&limit=100')
    const times = all.items.map((item) => String(item.processed_at ?? ''))
    assert.deepEqual(times, [...times].sort().reverse())
  })
})

describe('dev mock: a second, non-admin app user (x-mock-board-viewer: user)', () => {
  it('files its own +1 on a request the admin filed (the admin already holds one)', async () => {
    const [created, body] = await call('POST', '/feature-requests', {
      title: `A second viewer ${Date.now()}`, description: 'Two people want it.', fields: { customer: 'Acme', impact: 'none' }, name: 'Admin Demo',
    })
    assert.equal(created, 201, JSON.stringify(body))
    const path = `/feature-requests/${body.request.request_id}/supports`
    const support = { name: 'E2E User', fields: { customer: 'Example Air', impact: 'committed', amount_usd: 5000 } }

    assert.equal((await call('POST', path, support))[0], 409, 'the admin has filed its +1 with the request')
    const [added, answer] = await callAs('user', 'POST', path, support)
    assert.equal(added, 201, JSON.stringify(answer))
    assert.equal(answer.request.totals.supporters, 2)
    assert.equal((await callAs('user', 'POST', path, support))[0], 409, 'one +1 per person')
    // Only a viewer the mock defines: an inherited name (`constructor`) is the admin, whose +1 is filed.
    assert.equal((await callAs('constructor', 'POST', path, support))[0], 409, 'an inherited key is no viewer')
  })
})
