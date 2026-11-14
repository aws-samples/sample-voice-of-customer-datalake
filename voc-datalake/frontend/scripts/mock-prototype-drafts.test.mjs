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
  it('validates the instruction and refuses both or neither of instruction and pin_ids', async () => {
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

/** The feedback read's pins of `doc`'s series, flat. */
async function feedbackPins(doc) {
  const [, feedback] = await call('GET', `${PROJECT}/prototypes/${doc.document_id}/feedback`)
  return feedback.groups.flatMap((group) => group.items.flatMap((item) => item.pins))
}

describe('mock Incorporate (part 3): a draft from pin ids', () => {
  it('refuses a malformed, overlong, foreign or wholly withheld selection', async () => {
    const v1 = await build(`Incorporate checks ${String(Date.now())}`)
    const pins = await feedbackPins(v1)
    const flagged = pins.filter((pin) => pin.flagged).map((pin) => pin.pin_id)
    const many = Array.from({ length: 51 }, (_, i) => `pin_${String(i).padStart(20, '0')}abcdef`)
    const refusals = [
      [[], 'pin_ids must be a non-empty list'], [['not-a-pin'], 'pin_ids holds an invalid pin id'],
      [many, 'at most 50 pin_ids are allowed'], [['pin_00000000000000000000abcdef'], '1 of the selected pins are not pins of this prototype'],
      [flagged, 'Every selected pin was withheld: its text reads like an instruction to the AI'],
    ]
    for (const [pin_ids, error] of refusals) {
      const [status, body] = await call('POST', `${PROJECT}/prototypes/${v1.document_id}/drafts`, { pin_ids })
      assert.deepEqual([status, body.error], [400, error], JSON.stringify(pin_ids))
    }
    const both = await call('POST', `${PROJECT}/prototypes/${v1.document_id}/drafts`, { instruction: 'x', pin_ids: [pins[0].pin_id] })
    assert.deepEqual([both[0], both[1].error], [400, 'Give an instruction or pin_ids, not both'])
  })

  it('folds a repeated pin id', async () => {
    const v1 = await build(`Incorporate fold ${String(Date.now())}`)
    const open = (await feedbackPins(v1)).find((pin) => pin.status === 'open' && !pin.flagged)
    const [status, started] = await call('POST', `${PROJECT}/prototypes/${v1.document_id}/drafts`, { pin_ids: [open.pin_id, open.pin_id], instruction: null })
    assert.equal(status, 200, 'a null instruction is absent')
    await finished(started.job_id)
    const [, draft] = await call('GET', draftPath(v1, started.job_id))
    assert.deepEqual(draft.outcomes.map((o) => o.pin_id), [open.pin_id])
    const [, applied] = await call('POST', `${draftPath(v1, started.job_id)}/apply`)
    assert.equal(applied.document.revision_feedback, 'Incorporated 1 pin (1 done)')
  })

  it('withholds flagged pins, answers per accepted pin, and Apply marks and replies once, replays included', async () => {
    const v1 = await build(`Incorporate flow ${String(Date.now())}`)
    const pins = await feedbackPins(v1)
    const open = pins.filter((pin) => pin.status === 'open' && !pin.flagged).map((pin) => pin.pin_id)
    const flagged = pins.filter((pin) => pin.flagged).map((pin) => pin.pin_id)
    assert.ok(open.length >= 2 && flagged.length >= 1, 'the seeded pins have open and flagged ones')

    const [status, started] = await call('POST', `${PROJECT}/prototypes/${v1.document_id}/drafts`, { pin_ids: [...open, ...flagged] })
    assert.equal(status, 200, JSON.stringify(started))
    const job = await finished(started.job_id)
    assert.deepEqual(job.result, { draft_id: started.job_id })

    const [, draft] = await call('GET', draftPath(v1, started.job_id))
    assert.equal(draft.kind, 'feedback')
    assert.equal(draft.instruction, 'Incorporate the selected tester feedback')
    assert.deepEqual(draft.withheld, flagged)
    assert.deepEqual(draft.outcomes.map((o) => o.pin_id), open, 'one outcome per accepted pin, none for a withheld one')
    const done = draft.outcomes.filter((o) => o.outcome === 'done').map((o) => o.pin_id)
    const notDone = draft.outcomes.filter((o) => o.outcome === 'not_done').map((o) => o.pin_id)

    const [created, applied] = await call('POST', `${draftPath(v1, started.job_id)}/apply`)
    assert.equal(created, 201)
    const v2 = applied.document
    assert.equal(v2.revision_feedback, `Incorporated ${open.length} pins (${done.length} done)`)
    assert.equal(v2.revised_from_draft_id, started.job_id)
    assert.deepEqual(applied.incorporation, { marked: done, replied: notDone, not_written: [] })

    const [replayed, again] = await call('POST', `${draftPath(v1, started.job_id)}/apply`)
    assert.equal(replayed, 200)
    assert.deepEqual(again.incorporation, { marked: done, replied: notDone, not_written: [] })

    const after = new Map((await feedbackPins(v2)).map((pin) => [pin.pin_id, pin]))
    for (const id of done) assert.deepEqual([after.get(id).status, after.get(id).addressed_by], ['addressed', v2.document_id])
    for (const id of notDone) {
      const ai = after.get(id).replies.filter((reply) => reply.kind === 'ai')
      assert.equal(ai.length, 1, 'one model-written reply, even after the replay')
      assert.deepEqual([ai[0].by, ai[0].name, Object.keys(ai[0].approved_by).sort()], ['ai', 'AI', ['kind', 'sub']])
      assert.deepEqual(Object.keys(ai[0].llm_metadata).sort(), ['model', 'prompt_version'])
    }
    for (const id of flagged) assert.equal(after.get(id).replies.some((reply) => reply.kind === 'ai'), false, 'a withheld pin is never touched')

    // An editor reopens a Done pin: a replay reports it and leaves it open.
    const [reopened] = await call('POST', `${PROJECT}/prototypes/${after.get(done[0]).document_id}/pins/${done[0]}/reopen`, {})
    assert.equal(reopened, 200)
    const [, third] = await call('POST', `${draftPath(v1, started.job_id)}/apply`)
    assert.deepEqual(third.incorporation.not_written, [{ pin_id: done[0], reason: 'reopened' }])
    assert.equal(new Map((await feedbackPins(v2)).map((pin) => [pin.pin_id, pin])).get(done[0]).status, 'open')
  })
})

describe('mock walkthrough (part 1)', () => {
  /** The backend seam's place for a drafted step, to be checked and re-pointed. */
  const PLACEHOLDER_BOX = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }
  const STEPS = [
    { title: 'Your order', body: 'When it arrives.', selector: '#order-status' },
    { title: 'Pay', body: 'Shipping included.', anchor: { route: '', bbox: { x: 0.1, y: 0.6, w: 0.2, h: 0.05 } } },
  ]
  const walkthrough = (doc) => `${PROJECT}/prototypes/${doc.document_id}/walkthrough`

  it('a build carries an empty block; a save is a new version with the steps; a replay is the same version', async () => {
    const v1 = await build(`Walkthrough ${String(Date.now())}`)
    assert.ok(v1.content.includes('voc-walkthrough:start') && v1.content.includes('window.VoCWalkthrough'), 'the runtime is in every version')
    assert.deepEqual((await call('GET', walkthrough(v1)))[1], { steps: [] })

    const [created, saved] = await call('PUT', walkthrough(v1), { steps: STEPS, edit_id: 'wt-1' })
    assert.equal(created, 201)
    const v2 = saved.document
    assert.deepEqual([v2.version, v2.edit_kind, v2.edited_from_id], [2, 'edit', v1.document_id])
    assert.deepEqual((await call('GET', walkthrough(v2)))[1], { steps: STEPS })
    assert.deepEqual((await call('GET', walkthrough(v1)))[1], { steps: [] }, 'the earlier version keeps its own')

    const [replayed, again] = await call('PUT', walkthrough(v1), { steps: STEPS, edit_id: 'wt-1' })
    assert.deepEqual([replayed, again.document.document_id], [200, v2.document_id])
    assert.equal((await call('PUT', walkthrough(v1), { steps: STEPS, edit_id: 'wt-2' }))[0], 409, 'the series moved past v1')
  })

  it('names the step and field it refuses; a draft job answers placeholder places and writes nothing', async () => {
    const v1 = await build(`Walkthrough checks ${String(Date.now())}`)
    const [status, body] = await call('PUT', walkthrough(v1), { steps: [STEPS[0], { title: '', body: 'x', selector: '#a' }] })
    assert.deepEqual([status, body.error], [400, 'step 2: title must be 1-80 characters'])

    const [started, job] = await call('POST', `${walkthrough(v1)}/draft`, {})
    assert.equal(started, 202)
    const [, result] = await call('GET', `${PROJECT}/jobs/${job.job_id}`)
    assert.deepEqual(result.result.steps.map((step) => step.anchor.bbox), [PLACEHOLDER_BOX, PLACEHOLDER_BOX])
    assert.deepEqual((await call('GET', walkthrough(v1)))[1], { steps: [] })
  })

  it('reads the last steps block, as the server does: a copy earlier in the prototype\'s own markup never wins', async () => {
    // The mock writes the title into the HTML as is: here it carries a block ahead of the server's own.
    const decoy = '<script type="application/json" id="voc-walkthrough-steps">{"steps":[{"title":"Decoy","body":"B","selector":"#a"}]}</script>'
    const v1 = await build(`Walkthrough decoy ${String(Date.now())} ${decoy}`)
    assert.ok(v1.content.indexOf(decoy) < v1.content.lastIndexOf('id="voc-walkthrough-steps"'), 'the decoy comes first')
    assert.deepEqual((await call('GET', walkthrough(v1)))[1], { steps: [] })
    const [, saved] = await call('PUT', walkthrough(v1), { steps: STEPS, edit_id: 'wt-d' })
    assert.deepEqual((await call('GET', walkthrough(saved.document)))[1], { steps: STEPS })
  })

  it('drops one leading # from a step\'s route, as the server does', async () => {
    const v1 = await build(`Walkthrough routes ${String(Date.now())}`)
    const at = (route) => ({ title: 'T', body: 'B', anchor: { route, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } } })
    const [, saved] = await call('PUT', walkthrough(v1), { steps: [at('#checkout'), at('##x'), at('cart')], edit_id: 'wt-r' })
    const [, read] = await call('GET', walkthrough(saved.document))
    assert.deepEqual(read.steps.map((step) => step.anchor.route), ['checkout', '#x', 'cart'])
  })

  it('a draft takes an empty body or an object, and refuses any other body', async () => {
    const v1 = await build(`Walkthrough draft body ${String(Date.now())}`)
    const statuses = []
    for (const body of [undefined, { response_language: 'fr' }, ['not', 'an', 'object'], 'text']) {
      statuses.push((await call('POST', `${walkthrough(v1)}/draft`, body))[0])
    }
    assert.deepEqual(statuses, [202, 202, 400, 400])
  })

  it('keeps the steps across a revision and an applied draft', async () => {
    const title = `Walkthrough kept ${String(Date.now())}`
    const v1 = await build(title)
    const [, saved] = await call('PUT', walkthrough(v1), { steps: STEPS, edit_id: 'wt-k' })
    const v3 = await build(title, saved.document)
    assert.deepEqual((await call('GET', walkthrough(v3)))[1], { steps: STEPS }, 'a revision keeps its base\'s steps')
    const draftId = await draftOf(v3, 'move the footer')
    const [, applied] = await call('POST', `${draftPath(v3, draftId)}/apply`)
    assert.deepEqual((await call('GET', walkthrough(applied.document)))[1], { steps: STEPS }, 'Apply keeps them too')
  })
})
