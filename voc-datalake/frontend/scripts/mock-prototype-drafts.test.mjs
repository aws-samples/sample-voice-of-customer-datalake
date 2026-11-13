#!/usr/bin/env node

/**
 * The dev mock's prototype drafts (docs/prototype-builder.md, part 2), as the API answers them:
 *
 * - `POST …/prototypes/{id}/drafts` takes `{instruction}` (1–2,000 characters; `pin_ids` refused) and starts a
 *   `draft_prototype` job whose result is only `{draft_id}`; the draft's base is the series' newest version;
 * - `GET …/drafts/{draft_id}` answers the draft (its summary, base, instruction and a preview URL the mock
 *   serves as text/html) only for a finished draft of that series; any other is a 404;
 * - Apply writes the next version (`edit_kind: revise`, `revised_from_id`, `revision_feedback`, `edited_by`,
 *   `llm_metadata`, no `edited_from_id`) with 201, the same version with 200 on a replay, and 409 once the
 *   series moved past the base;
 * - Discard is the job DELETE: the draft GET, Apply and the preview are 404 after it.
 *
 * Boots mock-server.js on a free port. Run: node --test scripts/mock-prototype-drafts.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()
const call = mockCaller(mock)
const PROJECT = '/projects/proj_1'

/** Reads a job until it is finished (the mock advances one step per read); its record. */
async function finished(jobId) {
  for (let read = 0; read < 5; read += 1) {
    const [, job] = await call('GET', `${PROJECT}/jobs/${jobId}`)
    if (job.status === 'completed' || job.status === 'failed') return job
  }
  throw new Error(`job ${jobId} did not finish`)
}

/** A prototype built (or revised from `base`) through the mock's build job: its document. */
async function build(title, base) {
  const body = base === undefined ? { title } : { title, feedback: 'revise it', base_prototype_id: base.document_id }
  const [, started] = await call('POST', `${PROJECT}/build-prototype`, body)
  const job = await finished(started.job_id)
  const [, detail] = await call('GET', PROJECT)
  return detail.documents.find((d) => d.document_id === job.result.document_id)
}

/** A finished draft of `doc`'s series: its id. */
async function draftOf(doc, instruction) {
  const [status, started] = await call('POST', `${PROJECT}/prototypes/${doc.document_id}/drafts`, { instruction })
  assert.equal(status, 200, JSON.stringify(started))
  assert.equal(started.message, 'Prototype draft started.')
  const job = await finished(started.job_id)
  assert.equal(job.job_type, 'draft_prototype')
  assert.deepEqual(job.result, { draft_id: started.job_id }, 'the job result is the draft id alone')
  return started.job_id
}

const draftPath = (doc, draftId) => `${PROJECT}/prototypes/${doc.document_id}/drafts/${draftId}`

describe('mock prototype drafts', () => {
  it('validates the instruction and refuses pin_ids', async () => {
    const v1 = await build(`Draft checks ${String(Date.now())}`)
    for (const body of [{}, { instruction: '   ' }, { instruction: 'x'.repeat(2001) }, { instruction: 'x', pin_ids: ['pin_1'] }]) {
      const [status] = await call('POST', `${PROJECT}/prototypes/${v1.document_id}/drafts`, body)
      assert.equal(status, 400, JSON.stringify(body))
    }
    const [missing] = await call('POST', `${PROJECT}/prototypes/no_such_prototype/drafts`, { instruction: 'x' })
    assert.equal(missing, 404)
  })

  it('reads a draft of its series, serves its preview, applies it once and refuses a stale one', async () => {
    const title = `Draft flow ${String(Date.now())}`
    const v1 = await build(title)
    const v2 = await build(title, v1)
    // Drafted through v1's id: the base is still the newest version, v2.
    const draftId = await draftOf(v1, 'make the summary a sticky footer on phones')

    const [status, draft] = await call('GET', draftPath(v2, draftId))
    assert.equal(status, 200)
    assert.deepEqual([draft.draft_id, draft.base_document_id, draft.base_version], [draftId, v2.document_id, 2])
    assert.equal(draft.instruction, 'make the summary a sticky footer on phones')
    assert.equal(draft.summary.split('\n').length, 2)
    assert.ok(draft.summary.includes('make the summary a sticky footer on phones'))

    const preview = await fetch(draft.preview_url)
    assert.equal(preview.status, 200)
    assert.match(preview.headers.get('content-type') ?? '', /^text\/html/)
    assert.ok((await preview.text()).includes('Draft: make the summary a sticky footer on phones'))

    // Another series' prototype does not reach it.
    const other = await build(`Other series ${String(Date.now())}`)
    assert.equal((await call('GET', draftPath(other, draftId)))[0], 404)

    const [created, applied] = await call('POST', `${draftPath(v2, draftId)}/apply`)
    assert.equal(created, 201)
    const v3 = applied.document
    assert.equal(v3.version, 3)
    assert.equal(v3.edit_kind, 'revise')
    assert.equal(v3.revised_from_id, v2.document_id)
    assert.equal(v3.revision_feedback, 'make the summary a sticky footer on phones')
    assert.equal(v3.edited_by.kind, 'user')
    assert.deepEqual(Object.keys(v3.llm_metadata).sort(), ['model', 'prompt_version'])
    assert.equal(v3.edited_from_id, undefined)
    assert.ok(v3.content.includes('data-draft-note'))

    const [replayed, again] = await call('POST', `${draftPath(v2, draftId)}/apply`)
    assert.deepEqual([replayed, again.document.document_id], [200, v3.document_id])

    // A draft on v3, then the series moves (a restore): its Apply is a 409.
    const staleId = await draftOf(v3, 'another change')
    const [restored] = await call('POST', `${PROJECT}/documents/${v3.document_id}/versions/${v1.document_id}/restore`, { edit_id: 'drafts-test' })
    assert.equal(restored, 200)
    assert.equal((await call('POST', `${draftPath(v3, staleId)}/apply`))[0], 409)
  })

  it('is gone everywhere once its job is deleted (Discard)', async () => {
    const v1 = await build(`Draft discard ${String(Date.now())}`)
    const draftId = await draftOf(v1, 'drop the footer')
    const [, draft] = await call('GET', draftPath(v1, draftId))

    assert.equal((await call('DELETE', `${PROJECT}/jobs/${draftId}`))[0], 200)
    assert.equal((await call('GET', draftPath(v1, draftId)))[0], 404)
    assert.equal((await call('POST', `${draftPath(v1, draftId)}/apply`))[0], 404)
    assert.equal((await fetch(draft.preview_url)).status, 404)
  })
})
