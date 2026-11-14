/**
 * Which erasures name the current workspace (7.09.00): an erasure by author, source id, CSV row or email, and its job
 * list, act in the current workspace (the client's default scope); a whole-source erasure, and the list its panel
 * reads (the deployment's sources and jobs), never send `X-Workspace-Id`, since a workspace refuses one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { normalizeErasureJob, sourceProfilesApi } from './sourceProfilesApi'

const JOB = { job_id: 'erase_1', status: 'queued', field: 'author', value_hash: 'abc', deleted_items: 0, deleted_objects: 0 }

beforeEach(() => resetFetchApi())

describe('the erasure calls', () => {
  it("start a person's erasure in the current workspace (no scope given: the default)", async () => {
    routeFetchApi({ 'POST /settings/erasure': () => ({ job: JOB }) })
    await sourceProfilesApi.startErasure({ field: 'author', value: 'Jane', legal_basis: 'Erasure request' })
    expect(fetchApi.mock.calls[0]?.[2]).toBeUndefined()
  })

  it('start a whole-source erasure as the deployment', async () => {
    routeFetchApi({ 'POST /settings/erasure': () => ({ job: { ...JOB, field: 'source' } }) })
    await sourceProfilesApi.startSourceErasure({ source: 'webscraper', confirm: 'webscraper', legalBasis: 'Contract' })
    expect(fetchApi.mock.calls[0]?.[2]).toBe('deployment')
  })

  it("list the workspace's jobs by default, and the deployment's for the whole-source panel", async () => {
    routeFetchApi({ 'GET /settings/erasure': () => ({ jobs: [JOB], sources: ['webscraper'] }) })
    await sourceProfilesApi.listErasure()
    await sourceProfilesApi.listErasure('deployment')
    expect(fetchApi.mock.calls.map((call) => call[2])).toStrictEqual([undefined, 'deployment'])
  })

  it("read a workspace job's workspace, and none on the deployment's", () => {
    expect(normalizeErasureJob({ job: { ...JOB, workspace_id: 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8' } })?.workspace_id)
      .toBe('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
    expect(normalizeErasureJob({ job: JOB })?.workspace_id).toBeUndefined()
  })
})
