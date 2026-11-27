#!/usr/bin/env node

/**
 * The dev mock's Product tab (7.104.00, mock-product-sources.js) against the wire shape of the sources and proposal
 * routes: every source carries the nine new fields, a PDF declares its sha256 (echoed as the PUT's checksum header)
 * and waits for its …/uploaded and a link for its fetch, …/refresh reads again a link or a failed PDF only, the
 * extract runs as a listed project job and writes a proposal, an accept writes only a field still at its `seen`
 * value (a 409 `conflict` when none is), a proposal no longer open answers 409 `proposal_closed`, and the product
 * interviewer's end saves one voice interview source.
 *
 * Run: node --test scripts/mock-product-sources.test.mjs
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()
const call = mockCaller(mock)
const P = '/projects/proj_1'
// The SHA-256 of the four bytes `%PDF`.
const PDF_SHA256 = createHash('sha256').update('%PDF').digest('hex')
const NEW_FIELDS = ['source_kind', 'injection_flag', 'method', 'pages', 'truncated', 'url', 'final_url', 'title', 'interview_mode']

async function docs() {
  const [, body] = await call('GET', `${P}/product-docs`)
  return body.docs
}

describe('mock product sources', () => {
  it('reads a PDF after its PUT and …/uploaded, and a link after its fetch, each with the nine fields', async () => {
    const pdf = { filename: 'deck.pdf', content_type: 'application/pdf', size_bytes: 4 }
    assert.equal((await call('POST', `${P}/product-docs/upload-url`, pdf))[0], 400, 'a PDF without its sha256 is refused')
    const [, presigned] = await call('POST', `${P}/product-docs/upload-url`, { ...pdf, sha256: PDF_SHA256 })
    assert.deepEqual(presigned.headers, { 'Content-Type': 'application/pdf', 'x-amz-checksum-sha256': Buffer.from(PDF_SHA256, 'hex').toString('base64') })
    await fetch(presigned.presigned_url, { method: 'PUT', body: '%PDF' })
    assert.equal((await docs()).find((doc) => doc.doc_id === presigned.doc_id).status, 'pending')
    assert.equal((await call('POST', `${P}/product-docs/${presigned.doc_id}/uploaded`))[0], 202)
    const [linkStatus, link] = await call('POST', `${P}/product-docs/urls`, { url: 'https://example.com/product' })
    assert.deepEqual([linkStatus, (await call('POST', `${P}/product-docs/urls`, { url: 'http://example.com' }))[0]], [201, 400])
    await sleep(3200)
    const listed = await docs()
    assert.deepEqual(listed.map((doc) => [doc.source_kind, doc.status]), [['file', 'ready'], ['url', 'ready']])
    assert.ok(listed.every((doc) => NEW_FIELDS.every((field) => field in doc)), 'every source carries the nine fields')
    assert.equal(listed.find((doc) => doc.doc_id === link.doc.doc_id).title, 'Sample product page (mock)')
  })

  it('reads a link again on …/refresh, and refuses a Markdown file (not refreshable), a PDF read fine and a read under way', async () => {
    const listed = await docs()
    const link = listed.find((doc) => doc.source_kind === 'url')
    const pdf = listed.find((doc) => doc.content_type === 'application/pdf')
    const [, md] = await call('POST', `${P}/product-docs/upload-url`, { filename: 'notes.md', content_type: 'text/markdown', size_bytes: 3 })
    const refresh = async (doc) => {
      const [status, body] = await call('POST', `${P}/product-docs/${doc.doc_id}/refresh`)
      return [status, body.code]
    }
    assert.deepEqual([await refresh(link), await refresh(pdf), await refresh(md), await refresh(link)],
      [[202, undefined], [409, 'not_failed'], [409, 'not_refreshable'], [409, 'extracting']])
    await call('DELETE', `${P}/product-docs/${md.doc_id}`)
    await sleep(3200)
  })

  it('runs the extract as a listed job whose completion writes the proposal; a typed answer is a ready source', async () => {
    const [status, started] = await call('POST', `${P}/product-extract`, { response_language: 'en', effort: 'max' })
    assert.equal(status, 202)
    const read = async () => (await call('GET', `${P}/jobs`))[1].jobs.find((job) => job.job_id === started.job_id)
    assert.deepEqual([(await read()).status, (await read()).status], ['running', 'completed'])
    const [, latest] = await call('GET', `${P}/product-proposals/latest`)
    assert.equal(latest.proposal.status, 'open')
    assert.deepEqual(Object.keys(latest.proposal.fields).length, 12)
    assert.deepEqual(latest.proposal.fields.product_name, { ...latest.proposal.fields.product_name, status: 'proposed', current: '', changed_since: false })
    const [answered, answer] = await call('POST', `${P}/product-docs/answers`, { mode: 'typed', answers: [{ field: 'non_goals', question: 'Out?', answer: 'Freight' }] })
    assert.deepEqual([answered, answer.doc.source_kind, answer.doc.interview_mode, answer.doc.status], [201, 'interview', 'typed', 'ready'])
  })

  it('writes an accepted field still at its seen value, reports a changed one, and answers 409 when all changed', async () => {
    const [, latest] = await call('GET', `${P}/product-proposals/latest`)
    const accept = `${P}/product-proposals/${latest.proposal.proposal_id}/accept`
    await call('PUT', `${P}/product-context`, { one_liner: 'Typed by a person' })
    const [status, result] = await call('POST', accept, { fields: { product_name: { seen: '' }, one_liner: { seen: '' } } })
    assert.deepEqual([status, result.applied, result.conflicts], [200, ['product_name'], [{ field: 'one_liner', reason: 'changed' }]])
    const [, after] = await call('GET', `${P}/product-proposals/latest`)
    assert.deepEqual([after.field_meta.product_name.by, after.field_meta.one_liner.by, after.proposal.status], ['extract', 'person', 'partly_applied'])
    const [refused, conflict] = await call('POST', accept, { fields: { one_liner: { seen: '' } } })
    assert.deepEqual([refused, conflict.code, conflict.conflicts, conflict.applied], [409, 'conflict', [{ field: 'one_liner', reason: 'changed' }], []])
  })

  it('answers 409 proposal_closed to an accept or a dismiss of a proposal a newer extract replaced or that was dismissed', async () => {
    const [, before] = await call('GET', `${P}/product-proposals/latest`)
    const old = `${P}/product-proposals/${before.proposal.proposal_id}`
    const [, started] = await call('POST', `${P}/product-extract`, { response_language: 'en', effort: 'max' })
    const read = async () => (await call('GET', `${P}/jobs`))[1].jobs.find((job) => job.job_id === started.job_id)
    await read()
    assert.equal((await read()).status, 'completed')
    const [, latest] = await call('GET', `${P}/product-proposals/latest`)
    const current = `${P}/product-proposals/${latest.proposal.proposal_id}`
    const code = async (path, body) => {
      const [status, answer] = await call('POST', path, body)
      return [status, answer.code]
    }
    assert.deepEqual([await code(`${old}/accept`, { fields: { product_name: { seen: '' } } }), await code(`${old}/dismiss`)],
      [[409, 'proposal_closed'], [409, 'proposal_closed']])
    assert.deepEqual([await code(`${current}/dismiss`), await code(`${current}/dismiss`)], [[200, undefined], [200, undefined]])
    assert.deepEqual(await code(`${current}/accept`, { fields: { product_name: { seen: '' } } }), [409, 'proposal_closed'])
  })

  it('saves the product interviewer\'s end as one voice interview source', async () => {
    const sessions = `${P}/product-interview/voice-sessions`
    const [, started] = await call('POST', sessions, { consent: true, language: 'en', questions: [] })
    const [ended] = await call('POST', `${sessions}/${started.session_id}/end`)
    const [, view] = await call('GET', `${sessions}/${started.session_id}`)
    assert.deepEqual([ended, view.kind, view.status], [202, 'product_interview', 'finalized'])
    assert.equal((await docs()).find((doc) => doc.doc_id === view.source_doc_id).interview_mode, 'voice')
  })
})
