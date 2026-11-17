/**
 * @fileoverview The run workspace's wire reads against the shared fixture (item B's answers): the overview's new
 * fields (lanes, gates, cost against the cap, parent and children, an ended run's manifest), the thread and changes
 * read leniently (a bad entry costs itself, an answer off its shape is an error), the runs list as cursor pages, and
 * the steering and restart requests as the routes take them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi } from '@test/fetchApiRoutes'
import fixture from '@test/engineeringRunWorkspace.json'
import { parseOverview } from './engineeringRunsApi'
import { runWorkspaceApi } from './engineeringRunWorkspaceApi'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

beforeEach(() => { resetFetchApi() })

describe('the overview\'s new fields', () => {
  it('reads the lanes, the gates\' verdicts and the cost against the cap', () => {
    const overview = parseOverview(fixture.overview.answer)
    expect(overview.lanes.gate?.map((lane) => [lane.agent, lane.state, lane.attempt])).toStrictEqual([['gate-runner-4', 'done', 1], ['final-go-5', 'done', 1]])
    expect([overview.gates, overview.run.cost_usd, overview.run.cost_cap_usd]).toStrictEqual([{ gate: 'GO' }, 1.6095, 50])
    expect(overview.agents.find((agent) => agent.agent === 'fixer-3')).toMatchObject({ cost_usd: 0.9375, attempt: 2, skill_label: 'fixer@v3', model: 'model-medium' })
  })

  it('reads a run\'s children, an ended run\'s manifest and a child\'s parent', () => {
    const ended = parseOverview(fixture.ended_overview.answer)
    expect([ended.children.map((child) => [child.run_id, child.mode]), ended.run.manifest]).toStrictEqual([
      [[fixture.child_run_id, 'resume']], { cost_usd: 3.1415, tokens: 182000, written_at: '2026-11-17T07:05:00+00:00' },
    ])
    expect(parseOverview(fixture.child_overview.answer).run.parent).toMatchObject({ run_id: fixture.ended_run_id, mode: 'resume' })
  })
})

describe('the reads', () => {
  it('reads a thread page from its start, a bad item costing itself, and refuses an answer off its shape', async () => {
    fetchApi.mockResolvedValueOnce({ ...fixture.thread.answer, items: [...fixture.thread.answer.items, { ref: '' }, 'x'] })
    const page = await runWorkspaceApi.thread(fixture.run_id, fixture.agent, null)
    expect([page.items.length, page.next, page.done]).toStrictEqual([fixture.thread.answer.items.length, fixture.thread.answer.next, false])
    expect(fetchApi).toHaveBeenLastCalledWith(`/agents/engineering/${fixture.run_id}/agents/fixer-3/thread?limit=200`, undefined)
    fetchApi.mockResolvedValueOnce('nothing')
    await expect(runWorkspaceApi.thread(fixture.run_id, fixture.agent, 'c1')).rejects.toThrow('The thread answer was unreadable')
  })

  it('reads an agent\'s changes with its links, and one patch by its key', async () => {
    fetchApi.mockResolvedValueOnce(fixture.changes_checkpoint.answer)
    const changes = await runWorkspaceApi.changes(fixture.run_id, fixture.agent, fixture.changes_checkpoint.answer.key)
    expect([changes.source, changes.files.length, changes.patches.length, changes.pr_url]).toStrictEqual(['checkpoint', 1, 2, fixture.changes.answer.pr_url])
    expect(fetchApi).toHaveBeenLastCalledWith(`${fixture.changes.path}?${new URLSearchParams({ key: fixture.changes_checkpoint.answer.key }).toString()}`, undefined)
  })

  it('reads the runs as cursor pages', async () => {
    fetchApi.mockResolvedValueOnce(fixture.runs.answer)
    const page = await runWorkspaceApi.runs({ month: '2026-11', flow: '', status: '' }, null)
    expect([page.rows.map((run) => run.run_id), page.nextCursor]).toStrictEqual([fixture.runs.answer.runs.map((run) => run.run_id), null])
  })
})

describe('the actions', () => {
  it('steers the orchestrator, and restarts an ended run with confirm', async () => {
    fetchApi.mockResolvedValueOnce(fixture.steer.answer)
    expect(await runWorkspaceApi.steer(fixture.run_id, fixture.steer.body)).toBe(fixture.steer.answer.message.at)
    fetchApi.mockResolvedValueOnce(fixture.restart.answer)
    expect(await runWorkspaceApi.restart(fixture.ended_run_id, { mode: 'resume', base: 'same' })).toBe(fixture.restart.answer.run.run_id)
    expect(fetchApi).toHaveBeenLastCalledWith(fixture.restart.path, expect.objectContaining({ method: 'POST', body: JSON.stringify(fixture.restart.body) }))
  })
})
