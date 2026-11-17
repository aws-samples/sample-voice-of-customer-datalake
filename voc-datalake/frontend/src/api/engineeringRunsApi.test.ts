/**
 * @fileoverview The run monitor's wire reads: a full and a sparse overview (agents' sessions, tokens per model, no
 * cost yet), a signal's answer, a Stop's answer (7.50.03), a conversation page and the merge that keeps each message
 * once by seq.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchApi } from '@test/fetchApiRoutes'
import { engineeringRunsApi, parseConversationPage, parseOverview } from './engineeringRunsApi'
import { mergeBySeq } from './seqPages'
import { engineeringMessage, engineeringOverview } from '@test/engineeringRunFixtures'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

describe('parseOverview', () => {
  it.each([
    [{ monthly_usd: 50, alert_percent: 150, alert_month: '2026-11' }, { monthly_usd: 50, alert_percent: 150, alert_month: '2026-11' }],
    [{ monthly_usd: 50, alert_percent: null, alert_month: null }, { monthly_usd: 50, alert_percent: null, alert_month: null }],
    [{ monthly_usd: 50, alert_percent: 'x' }, { monthly_usd: 50, alert_percent: null, alert_month: null }],
    [{ monthly_usd: -1 }, null], ['lots', null], [null, null],
  ])('reads the run\'s flow budget leniently (%o)', (budget, read) => {
    expect(parseOverview(engineeringOverview({ budget })).run.budget).toStrictEqual(read)
  })

  it('reads a full overview as the server writes it', () => {
    const overview = parseOverview(engineeringOverview())
    expect(overview.run).toStrictEqual({
      run_id: 'RUN1', goal: 'Fix the paging bugs', repo: 'example-org/storefront', flow: 'wf_flow', status: 'running',
      started_at: '2026-11-12T08:00:00Z', ended_at: null, waiting_at: '', stop: null, budget: null, flow_steps: null,
      flow_revision: null, flow_definition: null, issue: null, pull_request: null,
    })
    expect(overview.agents.map((agent) => [agent.agent, agent.status, agent.task_id, agent.tokens.length])).toStrictEqual([
      ['coordinator-0', 'waiting', null, 1], ['fixer-1', 'working', 'task-1', 1], ['final-go-1', 'working', 'task-3', 0],
    ])
    expect(overview.totals).toStrictEqual({
      messages: 3, microvm_seconds: 900, by_model: [{ model: 'model-a', input_tokens: 2000, output_tokens: 400 }],
    })
    expect(Object.keys(overview)).toStrictEqual(['run', 'agents', 'actions_available', 'stop_available', 'totals', 'reactions'])
  })

  it('reads a Stop under way and the decision point a run waits at; an unsaid Stop is unavailable', () => {
    const stopping = parseOverview(engineeringOverview({ status: 'needs_human', waiting_at: 'coordinator',
      stop: { mode: 'stop', requested_at: '2026-11-17T05:00:00Z' } }))
    expect([stopping.run.waiting_at, stopping.run.stop]).toStrictEqual(
      ['coordinator', { mode: 'stop', requested_at: '2026-11-17T05:00:00Z' }])
    expect(parseOverview(engineeringOverview({ stop: 'soon' })).run.stop).toBeNull()
    expect(parseOverview({ ...engineeringOverview(), stop_available: undefined }).stop_available).toBe(false)
  })

  it('reads no reactions read as none, and a read off its shape as none too', () => {
    expect(parseOverview(engineeringOverview()).reactions).toBeNull()
    expect(parseOverview({ ...engineeringOverview(), reactions: { state: 'merged' } }).reactions).toBeNull()
  })

  it('reads the run\'s issue and pull request, and a link off its shape as none', () => {
    const issue = { host: 'gitlab', number: 3, url: 'https://gitlab.com/example-org/storefront/-/issues/3', verified: false }
    const linked = parseOverview(engineeringOverview({ issue, pull_request: { host: 'code-host', number: 7, url: 'u' } }))
    expect([linked.run.issue, linked.run.pull_request]).toStrictEqual([issue, null])
  })

  it('reads the flow a run follows: the revision it copied and each step\'s status', () => {
    const following = parseOverview(engineeringOverview({ flow_revision: 3, flow_steps: { start: 'done', board: 'ready' } }))
    expect([following.run.flow_revision, following.run.flow_steps]).toStrictEqual([3, { start: 'done', board: 'ready' }])
  })

  it('reads a sparse overview with defaults, and drops a bad agent alone', () => {
    const overview = parseOverview({
      run: { run_id: 'RUN1' }, agents: [{ agent: 'fixer-1', tokens: [{ model: 'm' }, 'x'] }, { role: 'nobody' }, 7],
    })
    expect(overview.agents).toStrictEqual([{
      agent: 'fixer-1', role: '', task_id: null, status: '', continuation: 0, started_at: null, step: null,
      microvm_state: null, microvm_age: null, heartbeat_age: null, last_progress_at: null, stuck_why: null,
      recent_tools: [], microvm_seconds: 0, tokens: [{ model: 'm', input_tokens: 0, output_tokens: 0 }],
    }])
    expect([overview.totals, overview.run.ended_at]).toStrictEqual([{ messages: 0, microvm_seconds: 0, by_model: [] }, null])
  })

  it('refuses an answer that is not an overview at all', () => {
    expect(() => parseOverview('nothing')).toThrow('The run answer was unreadable')
  })
})

describe('a signal', () => {
  it("answers each agent's status after it, or none when the answer names none", async () => {
    fetchApi.mockResolvedValueOnce({ signal: { event_id: 'e', signal: 'pause', agents: { 'fixer-1': 'pause_requested' }, applied: { 'fixer-1': true } } })
    expect(await engineeringRunsApi.signal('RUN1', { signal: 'pause' })).toStrictEqual({ agents: { 'fixer-1': 'pause_requested' }, applied: { 'fixer-1': true } })
    fetchApi.mockResolvedValueOnce({ something: 'else' })
    expect(await engineeringRunsApi.signal('RUN1', { signal: 'save' })).toStrictEqual({ agents: {}, applied: {} })
    expect(fetchApi).toHaveBeenLastCalledWith('/agents/engineering/RUN1/signals', expect.objectContaining({ method: 'POST' }))
  })
})

describe('a Stop', () => {
  it('posts a Stop, or a Stop now confirmed, and reads what it did; an answer with no status is an error', async () => {
    fetchApi.mockResolvedValueOnce({ stop: { status: 'stopped', mode: 'stop', tasks_closed: ['coordinate', 7],
      saving: [], agent_run: { agent_id: 'ag_1', run_id: 'ar_1', ended: true } } })
    expect(await engineeringRunsApi.stop('RUN1', { now: false })).toStrictEqual({ status: 'stopped', mode: 'stop',
      already: false, fell_back: false, tasks_closed: ['coordinate'], saving: [],
      agent_run: { agent_id: 'ag_1', run_id: 'ar_1', ended: true } })
    fetchApi.mockResolvedValueOnce({ stop: { status: 'stopping', mode: 'stop_now', saving: ['fixer-1'] } })
    expect((await engineeringRunsApi.stop('RUN1', { now: true })).saving).toStrictEqual(['fixer-1'])
    expect(fetchApi.mock.calls.slice(-2).map(([path, init]) => [path, init?.body]))
      .toStrictEqual([['/agents/engineering/RUN1/stop', '{}'],
        ['/agents/engineering/RUN1/stop', JSON.stringify({ now: true, confirm: true })]])
    fetchApi.mockResolvedValueOnce({ stop: {} })
    await expect(engineeringRunsApi.stop('RUN1', { now: false })).rejects.toThrow('unreadable')
  })
})

describe('a run\'s start', () => {
  it('posts the request and reads the run it started; an answer naming no run is an error', async () => {
    const request = { workflow_id: 'wf_1', connection: 'conn-1', commit: 'a'.repeat(40), language: 'python', goal: 'Fix it' }
    fetchApi.mockResolvedValueOnce({ run: { run_id: 'RUN1', status: 'active', workflow_id: 'wf_1' } })
    expect(await engineeringRunsApi.start(request)).toStrictEqual({ runId: 'RUN1' })
    expect(fetchApi).toHaveBeenLastCalledWith('/agents/engineering/runs',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }))
    fetchApi.mockResolvedValueOnce({ run: {} })
    await expect(engineeringRunsApi.start(request)).rejects.toThrow('unreadable')
  })
})

describe('the conversation', () => {
  it('reads a page and never moves behind where it started', () => {
    const page = parseConversationPage({ items: [engineeringMessage(3), { seq: 'x' }], next_after: 1 }, 2)
    expect(page.items.map((item) => item.seq)).toStrictEqual([3])
    expect(page.nextAfter).toBe(2)
    expect(parseConversationPage({ items: [engineeringMessage(5)] }, 0).nextAfter).toBe(5)
  })

  it('keeps each message once, by seq, in order', () => {
    const merged = mergeBySeq([engineeringMessage(1), engineeringMessage(3)], [engineeringMessage(3, 'again'), engineeringMessage(2)])
    expect(merged.map((item) => [item.seq, item.message.summary])).toStrictEqual([[1, 'Message 1'], [2, 'Message 2'], [3, 'again']])
  })
})
