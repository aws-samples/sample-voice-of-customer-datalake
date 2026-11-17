/**
 * @fileoverview An engineering agent's runs (7.47.00): the row says what the run started from and links to its run
 * monitor, with no Cancel; while it is live an admin stops it here with the run monitor's own Stop (7.50.03), which
 * ends its engineering run and so this run; Run now asks for an issue (required for a feature agent) and sends it; a
 * start that may have been written names its engineering run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { ApiError } from '../../lib/errors'
import { normalizeAgent } from '../../api/agentsApi'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { Agent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunsTab } = await import('./RunsTab')
const { RunNowConfirm } = await import('./RunNowConfirm')

const ENGINEERING_RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'

function agentOf(feedbackType: 'bug' | 'feature_request'): Agent {
  const agent = normalizeAgent({ agent_id: 'ag_1', name: 'Bug fixer', enabled: true, workflow_id: 'wf_1',
    engineering: { connection: 'storefront', language: 'python', feedback_type: feedbackType } })
  if (agent === null) throw new Error('fixture agent did not normalise')
  return agent
}

const run = (status: string) => ({
  run_id: 'ar_0001', agent_id: 'ag_1', status, trigger: 'github_issue', started_at: '2026-11-16T09:00:00Z', finished_at: null,
  project_id: null, current_node_id: null, model_calls: 0, error: null, workflow_id: 'wf_1', workflow_revision: 1,
  kind: 'engineering', engineering_run_id: ENGINEERING_RUN, issue: { repository: 'example-org/storefront', number: 42 },
  prd: null, feedback_count: null,
})

const FLOW = workflowView(1, { schema: 'voc-workflow/2', name: 'Bug fixer workflow', nodes: [], edges: [], loops: [] })

function routes(extra: Record<string, RouteHandler> = {}): void {
  routeFetchApi({
    'GET /agents/ag_1/runs': () => ({ items: [run('running')] }),
    'GET /agents/ag_1/runs/ar_0001': () => run('running'),
    'GET /agents/ag_1/runs/ar_0001/events?after=0': () => ({ items: [], next_after: 0 }),
    'GET /workflows/wf_1': () => FLOW,
    ...extra,
  }, { missStatus: 500 })
}

describe('an engineering agent\'s run', () => {
  beforeEach(() => { resetFetchApi() })

  it('says what it started from and links to its run monitor, with no Cancel', async () => {
    routes()
    renderWithQueryClient(<TestRouter><RunsTab agent={agentOf('bug')} isAdmin /></TestRouter>)
    expect(await screen.findByText('Started from issue #42 of example-org/storefront.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the run monitor' })).toHaveAttribute('href', `/agents/engineering/${ENGINEERING_RUN}`)
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
    expect(screen.getAllByText('GitHub issue').length).toBeGreaterThan(0)
  })

  it('stops a live run with the run monitor\'s Stop, says what it did and reads the runs again', async () => {
    const user = userEvent.setup()
    const now = { status: 'running' }
    routes({
      'GET /agents/ag_1/runs': () => ({ items: [run(now.status)] }),
      'GET /agents/ag_1/runs/ar_0001': () => run(now.status),
      [`POST /agents/engineering/${ENGINEERING_RUN}/stop`]: () => {
        now.status = 'cancelled'
        return { stop: { status: 'stopped', mode: 'stop', tasks_closed: ['coordinate'],
          agent_run: { agent_id: 'ag_1', run_id: 'ar_0001', ended: true } } }
      },
    })
    renderWithQueryClient(<TestRouter><RunsTab agent={agentOf('bug')} isAdmin /></TestRouter>)
    await user.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => { expect(sentFetchApiBody(`/agents/engineering/${ENGINEERING_RUN}/stop`, 'POST')).toStrictEqual({}) })
    // (the run is no longer live once the agent's runs are read again: its Stop goes, what it did stays said)
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument() })
    expect(screen.getByText("Stopped. 1 open task was closed. Its automation's run is cancelled, so the automation can run again."))
      .toBeInTheDocument()
  })

  it('offers no Stop for a run that has ended, nor to anyone but an admin', async () => {
    routes({ 'GET /agents/ag_1/runs': () => ({ items: [run('completed')] }), 'GET /agents/ag_1/runs/ar_0001': () => run('completed') })
    const { unmount } = renderWithQueryClient(<TestRouter><RunsTab agent={agentOf('bug')} isAdmin /></TestRouter>)
    expect(await screen.findByText('Started from issue #42 of example-org/storefront.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    unmount()
    routes()
    renderWithQueryClient(<TestRouter><RunsTab agent={agentOf('bug')} isAdmin={false} /></TestRouter>)
    expect(await screen.findByText('Started from issue #42 of example-org/storefront.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('names the engineering run a start may have written', async () => {
    const user = userEvent.setup()
    routes({
      'GET /agents/ag_1/runs': () => ({ items: [] }),
      'POST /agents/ag_1/run': () => { throw new ApiError(503, `run ${ENGINEERING_RUN} may have been started`, undefined, ENGINEERING_RUN) },
    })
    renderWithQueryClient(<TestRouter><RunsTab agent={agentOf('bug')} isAdmin /></TestRouter>)
    await user.click(await screen.findByRole('button', { name: 'Run now' }))
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    const link = await screen.findByRole('link', { name: /open/i })
    expect(link).toHaveAttribute('href', `/agents/engineering/${ENGINEERING_RUN}`)
  })
})

describe('Run now of an engineering agent', () => {
  beforeEach(() => {
    resetFetchApi()
    routeFetchApi({ 'GET /workflows/wf_1': () => FLOW })
  })

  it('sends the issue a bug agent is asked to fix, and nothing for a bug hunt', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    renderWithQueryClient(<RunNowConfirm agent={agentOf('bug')} starting={false} onConfirm={onConfirm} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    expect(onConfirm).toHaveBeenLastCalledWith(undefined)
    await user.type(screen.getByLabelText('Issue number (optional)'), '42')
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    expect(onConfirm).toHaveBeenLastCalledWith({ issue: 42 })
  })

  it('needs an issue for a feature agent, and a whole number for any', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<RunNowConfirm agent={agentOf('feature_request')} starting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled()
    await user.type(screen.getByLabelText('Issue number'), 'x1')
    expect(screen.getByText("The issue's number: a whole number from 1.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled()
  })

  it('posts the issue to the agent\'s run', async () => {
    const user = userEvent.setup()
    routeFetchApi({
      'GET /agents/ag_1/runs': () => ({ items: [] }),
      'GET /workflows/wf_1': () => FLOW,
      'POST /agents/ag_1/run': () => ({ run: run('running') }),
      'GET /agents/ag_1/runs/ar_0001': () => run('running'),
      'GET /agents/ag_1/runs/ar_0001/events?after=0': () => ({ items: [], next_after: 0 }),
    }, { missStatus: 500 })
    renderWithQueryClient(<TestRouter><RunsTab agent={agentOf('bug')} isAdmin /></TestRouter>)
    await user.click(await screen.findByRole('button', { name: 'Run now' }))
    await user.type(screen.getByLabelText('Issue number (optional)'), '7')
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    await waitFor(() => { expect(sentFetchApiBody('/agents/ag_1/run', 'POST')).toStrictEqual({ issue: 7 }) })
  })
})
