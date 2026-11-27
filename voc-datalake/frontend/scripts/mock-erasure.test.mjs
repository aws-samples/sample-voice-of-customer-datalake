#!/usr/bin/env node

/**
 * The dev mock's erasure jobs keep to their scope (shared/erasure_scope.py, 7.97.00's panel): a job started with
 * X-Workspace-Id is that workspace's and is listed there only, the deployment lists the jobs that name no workspace,
 * a workspace refuses a whole-source erasure, and a finished erasure by email says what it walked (the fields the
 * panel reads: participants, the deployment's projects, the review registries). Boots mock-server.js on a free port.
 *
 * Run: node --test scripts/mock-erasure.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()
const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
const BASIS = 'Erasure request 42'

async function call(method, workspace, body) {
  const headers = { 'Content-Type': 'application/json', ...(workspace ? { 'X-Workspace-Id': workspace } : {}) }
  const response = await fetch(`${mock.base}/settings/erasure`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return [response.status, await response.json()]
}

/** Poll the scope's list until the job has finished (each GET moves it one phase; at most 12 polls). */
async function finished(jobId, workspace) {
  for (let poll = 0; poll < 12; poll += 1) {
    const [, { jobs }] = await call('GET', workspace)
    const job = jobs.find((j) => j.job_id === jobId)
    if (job && job.status !== 'queued' && job.status !== 'running') return job
  }
  throw new Error(`job ${jobId} did not finish in 12 polls`)
}

describe('dev mock: erasure jobs by scope', () => {
  it("lists a workspace's job in that workspace only, with what it walked", async () => {
    const [status, { job }] = await call('POST', WS, { field: 'email', value: 'pat@example.com', legal_basis: BASIS })
    assert.equal(status, 202)
    assert.equal(job.workspace_id, WS)
    const [, deployment] = await call('GET', null)
    assert.equal(deployment.jobs.some((j) => j.job_id === job.job_id), false)
    const [, other] = await call('GET', 'ws_01JCJNPR0000000000000000J1')
    assert.deepEqual(other.jobs, [])
    assert.deepEqual(other.sources, [])

    const done = await finished(job.job_id, WS)
    assert.equal(done.status, 'completed')
    assert.equal(done.participants_complete, true)
    assert.equal(done.deployment_projects_walked, undefined)
    assert.equal(done.review_registries, undefined)
  })

  it("lists the deployment's erasure by email outside every workspace, its projects and registries read", async () => {
    const [, { job }] = await call('POST', null, { field: 'email', value: 'sam@example.com', legal_basis: BASIS })
    assert.equal(job.workspace_id, undefined)
    const [, inside] = await call('GET', WS)
    assert.equal(inside.jobs.some((j) => j.job_id === job.job_id), false)
    const done = await finished(job.job_id, null)
    assert.deepEqual([done.participants_complete, done.deployment_projects_walked, done.review_registries],
      [true, true, 'complete'])
  })

  it('lists the sources a whole-source erasure may name for the deployment only', async () => {
    const [, deployment] = await call('GET', null)
    assert.ok(deployment.sources.length > 0)
    assert.ok(deployment.sources.every((id) => /^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)))
  })

  it('says nothing of participants or projects on an erasure by another field', async () => {
    const [, { job }] = await call('POST', null, { field: 'author', value: 'Pat Reviewer', legal_basis: BASIS })
    const done = await finished(job.job_id, null)
    assert.deepEqual(Object.keys(done).filter((key) => key.startsWith('participant') || key.startsWith('deployment_')), [])
    assert.equal(done.review_registries, 'complete')
  })

  it("seeds one finished deployment job that owes lineage and kept a file, for the panel's preview", async () => {
    const [, { jobs }] = await call('GET', null)
    const seeded = jobs.find((j) => j.job_id === 'er_mockowed0001')
    assert.ok(seeded)
    assert.deepEqual([seeded.status, seeded.lineage_owed, seeded.lineage_owed_reason, seeded.lineage_owed_mode,
      seeded.review_registries], ['completed', true, 'not_backfilled', 'erase', 'not_backfilled'])
    assert.equal(seeded.files_needing_review.keys.length, 1)
    const [, inside] = await call('GET', WS)
    assert.equal(inside.jobs.some((j) => j.job_id === 'er_mockowed0001'), false)
  })

  it('refuses a whole-source erasure in a workspace', async () => {
    const [status, body] = await call('POST', WS, { field: 'source', value: 'webscraper', confirm: 'webscraper', legal_basis: BASIS })
    assert.equal(status, 400)
    assert.match(body.error, /a whole-source erasure is the deployment's/)
  })
})
