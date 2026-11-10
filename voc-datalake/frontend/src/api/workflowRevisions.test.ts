/**
 * @fileoverview `workflowsApi.getRevision` (`GET /workflows/{id}/revisions/{n}`) and the
 * `revisions` list of `workflowsApi.get`: the wire shapes decode through their Zod
 * boundaries — a lenient definition, a thrown error for an unreadable answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetFetchApi, routeFetchApi as route, fetchApi } from '@test/fetchApiRoutes'
import { MINI_WORKFLOW, workflowView } from '@test/workflowFixtures'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { workflowsApi, workflowsKeys } = await import('./workflowsApi')

beforeEach(() => {
  resetFetchApi()
})

describe('workflowsApi.getRevision', () => {
  it('reads one saved revision from its own path, with its definition decoded', async () => {
    route({
      'GET /workflows/wf_1/revisions/2': () => ({
        workflow_id: 'wf_1', revision: 2, name: 'Mini', definition: { ...MINI_WORKFLOW, extra: 'dropped' },
        saved_at: '2026-10-01T09:00:00Z', saved_by_username: 'alice',
      }),
    })
    const revision = await workflowsApi.getRevision('wf_1', 2)
    expect(revision).toMatchObject({ workflow_id: 'wf_1', revision: 2, name: 'Mini', saved_at: '2026-10-01T09:00:00Z', saved_by_username: 'alice' })
    expect(revision.definition?.nodes.map((n) => n.id)).toStrictEqual(MINI_WORKFLOW.nodes.map((n) => n.id))
    expect(revision.definition).not.toHaveProperty('extra')
  })

  it('keeps the revision when its stored definition is unreadable (definition null)', async () => {
    route({ 'GET /workflows/wf_1/revisions/1': () => ({ workflow_id: 'wf_1', revision: 1, name: 'Old', definition: 'not json', saved_at: null, saved_by_username: null }) })
    const revision = await workflowsApi.getRevision('wf_1', 1)
    expect(revision.definition).toBeNull()
    expect(revision.saved_by_username).toBeNull()
  })

  it('rejects an answer without a revision number', async () => {
    route({ 'GET /workflows/wf_1/revisions/1': () => ({ workflow_id: 'wf_1', name: 'Old' }) })
    await expect(workflowsApi.getRevision('wf_1', 1)).rejects.toThrow('unreadable')
  })

  it('encodes the workflow id in the path', async () => {
    route({ 'GET /workflows/wf%2F1/revisions/3': () => ({ workflow_id: 'wf/1', revision: 3, name: '', definition: MINI_WORKFLOW, saved_at: null, saved_by_username: null }) })
    await workflowsApi.getRevision('wf/1', 3)
    expect(fetchApi.mock.calls[0]?.[0]).toBe('/workflows/wf%2F1/revisions/3')
  })

  it('caches a revision under its workflow, so invalidating the workflow covers it', () => {
    expect(workflowsKeys.revision('wf_1', 2).slice(0, 3)).toStrictEqual([...workflowsKeys.detail('wf_1')])
  })
})

describe('workflowsApi.get revisions', () => {
  it('keeps the readable revision summaries and drops a malformed one', async () => {
    route({
      'GET /workflows/wf_1': () => ({
        ...workflowView(2, MINI_WORKFLOW),
        revisions: [
          { revision: 2, saved_at: '2026-10-02T09:00:00Z', saved_by_username: 'alice', saved_by: 'never-read' },
          { revision: 'one' },
          { revision: 1, saved_at: null, saved_by_username: null },
        ],
      }),
    })
    const { revisions } = await workflowsApi.get('wf_1')
    expect(revisions).toStrictEqual([
      { revision: 2, saved_at: '2026-10-02T09:00:00Z', saved_by_username: 'alice' },
      { revision: 1, saved_at: null, saved_by_username: null },
    ])
  })
})
