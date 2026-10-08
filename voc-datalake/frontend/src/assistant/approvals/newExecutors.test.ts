/**
 * The memory / agents / company executors hit the documented REST routes with
 * the documented bodies, map the refusals the model must act on, and
 * invalidate what the pages read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

vi.mock('../../api/client', (importOriginal) => import('@test/fetchApiRoutes').then((h) => h.clientWithMockedFetchApi(importOriginal)))

import { getWriteTool } from './registry'
import { STALE_WORKFLOW_MESSAGE } from './agentExecutors'
import type { PageContext } from '../contract'
import { fetchApi } from '@test/fetchApiRoutes'
import { wfEdge, wfNode } from '@test/workflowFixtures'

const PAGE: PageContext = { kind: 'agent', path: '/agents/ag_1', agentId: 'ag_1' }
const AGENT = { agent_id: 'ag_1', name: 'Watcher' }
const RUN = { run_id: 'ar_1', agent_id: 'ag_1', status: 'queued' }
const WF = {
  schema: 'voc-workflow/1',
  name: 'Mini',
  nodes: [wfNode('s', 'start', 'Start'), wfNode('e', 'end', 'End', 1)],
  edges: [wfEdge('e1', 's', 'e')],
  loops: [],
}
const VIEW = { workflow_id: 'wf_2', name: 'Mini', revision: 3, definition: WF }

/** The registered write tool `name`; a missing one fails the test. */
function writeTool(name: string) {
  const def = getWriteTool(name)
  if (def === undefined) throw new Error(`no tool ${name}`)
  return def
}

/** Validate `args` like the approval layer does, then execute the tool on {@link PAGE}. */
function executeTool(queryClient: QueryClient, name: string, args: unknown) {
  const def = writeTool(name)
  return def.execute(def.argsSchema.parse(args), { queryClient, page: PAGE })
}

/** A run(name, args) bound to a fresh QueryClient, and the query keys it invalidated (as JSON). */
function setup() {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  return {
    run: (name: string, args: unknown) => executeTool(queryClient, name, args),
    invalidated: () => invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey)),
  }
}

/** The RequestInit of a recorded fetchApi call, when it carried one. */
function requestInit(value: unknown): RequestInit | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

/** [endpoint, method, parsed body] of every fetchApi call. */
const calls = () => fetchApi.mock.calls.map(([endpoint, rawInit]: unknown[]) => {
  const init = requestInit(rawInit)
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  return [endpoint, init?.method ?? 'GET', body]
})

beforeEach(() => { vi.clearAllMocks() })

describe('memory executors', () => {
  it('remember → POST /memory with the args, reporting a proposal', async () => {
    fetchApi.mockResolvedValue({ memory: { memory_id: 'mem_9', status: 'proposed' } })
    const { run, invalidated } = setup()
    const result = await run('remember', { scope: 'company', statement: 'S', kind: 'product' })
    expect(calls()).toStrictEqual([['/memory', 'POST', { scope: 'company', statement: 'S', kind: 'product' }]])
    expect(result.summary).toContain('PROPOSAL')
    expect(invalidated()).toContain('["memory"]')
  })

  it('update_company_memory → PUT /memory/{id} {statement}', async () => {
    fetchApi.mockResolvedValue({ memory: { memory_id: 'mem_1', status: 'active' } })
    const { run } = setup()
    await run('update_company_memory', { memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product', reason: 'r' })
    expect(calls()).toStrictEqual([['/memory/mem_1', 'PUT', { statement: 'B' }]])
  })

  it('update_company_memory: a 403 files the statement as a company POST /memory instead', async () => {
    fetchApi.mockRejectedValueOnce(new Error('API Error: 403')).mockResolvedValueOnce({ memory: { memory_id: 'mem_7', status: 'proposed' } })
    const { run } = setup()
    const result = await run('update_company_memory', { memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product', reason: 'r' })
    expect(calls()).toStrictEqual([
      ['/memory/mem_1', 'PUT', { statement: 'B' }],
      ['/memory', 'POST', { scope: 'company', statement: 'B', kind: 'product' }],
    ])
    expect(result.data).toStrictEqual({ id: 'mem_7', status: 'proposed', replaces: 'mem_1' })
  })

  it('update_company_memory: other failures propagate', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    const { run } = setup()
    await expect(run('update_company_memory', { memory_id: 'mem_1', previous_statement: 'A', statement: 'B', kind: 'product', reason: 'r' }))
      .rejects.toThrow('API Error: 500')
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['forget_memory', { memory_id: 'mem_1', statement: 'A', reason: 'r' }, ['/memory/mem_1/forget', 'POST', undefined]],
    ['confirm_memory', { memory_id: 'mem_1', statement: 'A' }, ['/memory/mem_1/confirm', 'POST', undefined]],
    ['merge_memories', { memory_ids: ['mem_1', 'mem_2'], statement: 'M' }, ['/memory/merge', 'POST', { ids: ['mem_1', 'mem_2'], statement: 'M' }]],
    ['resolve_memory_conflict', { memory_id: 'mem_1', action: 'keep', winner_id: 'mem_2' }, ['/memory/review/mem_1/resolve', 'POST', { action: 'keep', winner_id: 'mem_2' }]],
  ])('%s → its route', async (name, args, call) => {
    fetchApi.mockResolvedValue({})
    await setup().run(name, args)
    expect(calls()).toStrictEqual([call])
  })
})

describe('agent executors', () => {
  it.each([
    ['create_agent', { name: 'Watcher', scope: { all: true, categories: [], subcategories: [] } }, AGENT,
      ['/agents', 'POST', { name: 'Watcher', scope: { all: true, categories: [], subcategories: [] } }]],
    ['update_agent', { agent_id: 'ag_1', updates: { instructions: 'x' }, change_summary: 's' }, AGENT, ['/agents/ag_1', 'PUT', { instructions: 'x' }]],
    ['enable_agent', { agent_id: 'ag_1' }, AGENT, ['/agents/ag_1/enable', 'POST', undefined]],
    ['disable_agent', { agent_id: 'ag_1' }, AGENT, ['/agents/ag_1/disable', 'POST', undefined]],
    ['run_agent', { agent_id: 'ag_1' }, { run: RUN }, ['/agents/ag_1/run', 'POST', undefined]],
    ['cancel_agent_run', { agent_id: 'ag_1', run_id: 'ar_1' }, { run: { ...RUN, status: 'cancelled' } }, ['/agents/ag_1/runs/ar_1/cancel', 'POST', undefined]],
    ['create_workflow', { definition: WF }, { workflow: VIEW }, ['/workflows', 'POST', { definition: WF }]],
    ['update_workflow', { workflow_id: 'wf_2', expected_revision: 2, definition: WF, change_summary: 's' }, { workflow: VIEW },
      ['/workflows/wf_2', 'PUT', { definition: WF, expected_revision: 2 }]],
    ['duplicate_workflow', { workflow_id: 'wf_default', name: 'Copy' }, { workflow: VIEW }, ['/workflows/wf_default/duplicate', 'POST', { name: 'Copy' }]],
  ])('%s → its route', async (name, args, answer, call) => {
    fetchApi.mockResolvedValue(answer)
    await setup().run(name, args)
    expect(calls()).toStrictEqual([call])
  })

  it('a stale update_workflow (409) tells the model to re-read and rebuild', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 409'))
    await expect(setup().run('update_workflow', { workflow_id: 'wf_2', expected_revision: 2, definition: WF, change_summary: 's' }))
      .rejects.toThrow(STALE_WORKFLOW_MESSAGE)
  })

  it('run_agent while a run is active (409) says nothing was started', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 409'))
    await expect(setup().run('run_agent', { agent_id: 'ag_1' })).rejects.toThrow('already has a run in progress')
  })

  it('agent writes invalidate the agent, its runs and the list', async () => {
    fetchApi.mockResolvedValue(AGENT)
    const { run, invalidated } = setup()
    await run('enable_agent', { agent_id: 'ag_1' })
    expect(invalidated()).toStrictEqual(['["agents","detail","ag_1"]', '["agents","runs","ag_1"]', '["agents","list"]'])
  })
})

describe('company executors', () => {
  it('update_company_context fills the missing half from the stored document', async () => {
    fetchApi.mockResolvedValueOnce({ vision: 'Old', objectives: [{ id: 'o1', title: 'T', description: '', horizon: 'long' }] }).mockResolvedValueOnce({})
    await setup().run('update_company_context', { vision: 'New' })
    expect(calls()).toStrictEqual([
      ['/settings/company-context', 'GET', undefined],
      ['/settings/company-context', 'PUT', { vision: 'New', objectives: [{ id: 'o1', title: 'T', description: '', horizon: 'long' }] }],
    ])
  })

  it('update_my_context → PUT /settings/my-context', async () => {
    fetchApi.mockResolvedValue({})
    await setup().run('update_my_context', { objectives: [] })
    expect(calls()).toStrictEqual([['/settings/my-context', 'PUT', { objectives: [] }]])
  })

  it('update_design_system keeps the stored tokens when only guidelines change', async () => {
    const tokens = { colors: [{ name: 'primary', value: '#000' }], typography: [] }
    fetchApi.mockResolvedValueOnce({ tokens, guidelines: 'Old' }).mockResolvedValueOnce({})
    await setup().run('update_design_system', { guidelines: 'New' })
    expect(calls()[1]).toStrictEqual(['/settings/design-system', 'PUT', { tokens, guidelines: 'New' }])
  })
})
