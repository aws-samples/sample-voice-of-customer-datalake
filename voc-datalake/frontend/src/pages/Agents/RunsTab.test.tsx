/**
 * @fileoverview Runs tab: the run list, the selected run's incremental event
 * polling (`?after=`), the event log, the read-only graph lit by events, and
 * the admin-only Cancel / Run now buttons (Run now asks first; 409 → "already
 * running"), and a failed run's reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { wfEdge, wfNode, workflowView } from '@test/workflowFixtures'
import { scoutAgent } from '@test/agentFixtures'
import { RUN_POLL_MS } from './useAgents'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'
import { at } from '@test/defined'
import enCommon from '../../../public/locales/en/common.json'
import enAgents from '../../../public/locales/en/agents.json'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunsTab } = await import('./RunsTab')

const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  run_id: id, agent_id: 'ag_1', status, trigger: 'manual', started_at: '2026-10-04T09:00:00Z', finished_at: null,
  project_id: null, current_node_id: null, model_calls: 12, error: null, workflow_id: 'wf_1', workflow_revision: 2, ...extra,
})

const WORKFLOW = workflowView(2, {
  schema: 'voc-workflow/1', name: 'Flow',
  nodes: [
    wfNode('start', 'start', 'Start'),
    wfNode('prd', 'write_prd', 'Write the PRD', 140),
    wfNode('end', 'end', 'Done', 280, { status: 'completed' }),
  ],
  edges: [wfEdge('e1', 'start', 'prd'), wfEdge('e2', 'prd', 'end')],
  loops: [],
})

const EVENTS = [
  { seq: 1, at: '2026-10-04T09:00:01Z', kind: 'node_started', node_id: 'start', summary: 'Kicked off' },
  { seq: 2, at: '2026-10-04T09:00:02Z', kind: 'node_finished', node_id: 'start', summary: 'Started cleanly' },
  { seq: 3, at: '2026-10-04T09:00:03Z', kind: 'node_started', node_id: 'prd', summary: 'Drafting the PRD', ref: { project_id: 'p_9' } },
]

/** One active run (run_1, newest) and one finished run (run_0). */
const activeRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  'GET /agents/ag_1/runs': () => ({ items: [run('run_1', 'running', { current_node_id: 'prd' }), run('run_0', 'completed')] }),
  'GET /agents/ag_1/runs/run_1': () => run('run_1', 'running', { current_node_id: 'prd' }),
  'GET /agents/ag_1/runs/run_1/events?after=0': () => ({ items: EVENTS, next_after: 3 }),
  'GET /agents/ag_1/runs/run_1/events?after=3': () => ({ items: [], next_after: 3 }),
  'GET /agents/ag_1/runs/run_0': () => run('run_0', 'completed'),
  'GET /agents/ag_1/runs/run_0/events?after=0': () => ({ items: [{ seq: 1, at: '', kind: 'message', summary: 'Older run note' }] }),
  'GET /workflows/wf_1': () => WORKFLOW,
  ...extra,
})

/** Only finished runs, so Run now is enabled. */
const idleRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  'GET /agents/ag_1/runs': () => ({ items: [run('run_0', 'completed')] }),
  'GET /agents/ag_1/runs/run_0': () => run('run_0', 'completed'),
  'GET /agents/ag_1/runs/run_0/events?after=0': () => ({ items: [] }),
  'GET /workflows/wf_1': () => WORKFLOW,
  ...extra,
})

function renderTab(isAdmin = true) {
  return renderWithQueryClient(<TestRouter><RunsTab agent={scoutAgent()} isAdmin={isAdmin} /></TestRouter>)
}

const eventLog = () => screen.getByRole('region', { name: 'Event log' })
const findEventLog = () => screen.findByRole('region', { name: 'Event log' })
/** The step graph and the event log sit behind "Show technical log" (the plain summary comes first). */
const openTechnical = async () => userEvent.click(await screen.findByRole('button', { name: 'Show technical log' }))
const calledWith = (endpoint: string) => fetchApi.mock.calls.some(([e]) => e === endpoint)

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RunsTab — list and event log', () => {
  it('lists the runs and opens the newest one', async () => {
    route(activeRoutes())
    renderTab()
    const list = await screen.findByRole('list', { name: 'Runs' })
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(within(list).getAllByRole('button')[0]).toHaveAttribute('aria-current', 'true')
    await openTechnical()
    expect(await within(await findEventLog()).findByText('Drafting the PRD')).toBeInTheDocument()
  })

  // Design audit D-CONTRAST: text-muted was 4.09:1 on the selected row's
  // --nav-active-bg (dark) and light badge-ok 4.27:1; the selected row uses
  // text-text and backs its status pill with the card colour.
  it('keeps secondary text and the status pill readable on the selected row', async () => {
    route(activeRoutes())
    renderTab()
    const list = await screen.findByRole('list', { name: 'Runs' })
    const [selected, other] = within(list).getAllByRole('button')
    for (const span of selected?.querySelectorAll('span.text-\\[12px\\]') ?? []) {
      expect(span).toHaveClass('text-text')
      expect(span).not.toHaveClass('text-muted')
    }
    expect(selected?.querySelector('.badge')?.parentElement).toHaveClass('bg-card')
    expect(other?.querySelector('span.text-\\[12px\\]')).toHaveClass('text-muted')
  })

  it('renders the event log with kinds, steps and project links', async () => {
    route(activeRoutes())
    renderTab()
    await openTechnical()
    await screen.findByText('Drafting the PRD')
    const log = eventLog()
    expect(within(log).getAllByText('Step started')).toHaveLength(2)
    expect(within(log).getByText('Write the PRD')).toBeInTheDocument()
    expect(within(log).getByRole('link', { name: 'Open a project' })).toHaveAttribute('href', '/projects/p_9')
  })

  it('polls the events of an active run incrementally with ?after=', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    route(activeRoutes())
    renderTab()
    await openTechnical()
    await screen.findByText('Drafting the PRD')
    expect(calledWith('/agents/ag_1/runs/run_1/events?after=0')).toBe(true)
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS + 100)
    await waitFor(() => expect(calledWith('/agents/ag_1/runs/run_1/events?after=3')).toBe(true))
  })

  it('loads the events of the run the user selects', async () => {
    route(activeRoutes())
    renderTab()
    const list = await screen.findByRole('list', { name: 'Runs' })
    await openTechnical()
    await userEvent.click(at(within(list).getAllByRole('button'), 1))
    expect(await within(await findEventLog()).findByText('Older run note')).toBeInTheDocument()
    expect(calledWith('/agents/ag_1/runs/run_0/events?after=0')).toBe(true)
  })

  it('keeps the scrolling event list keyboard-reachable and the selected row readable (E2E s2 F6)', async () => {
    route(activeRoutes())
    renderTab()
    await openTechnical()
    await screen.findByText('Drafting the PRD')
    // axe scrollable-region-focusable: the overflow list must take focus to be scrolled by keyboard.
    const list = within(eventLog()).getByRole('list', { name: 'Event log' })
    expect(list).toHaveAttribute('tabindex', '0')
    // axe color-contrast: muted text on the selected row's nav-active background.
    const selected = at(within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('button'), 0)
    expect(selected).toHaveAttribute('aria-current', 'true')
    expect(selected.querySelector('.text-muted')).toBeNull()
  })

  it('says so when there are no runs', async () => {
    route({ 'GET /agents/ag_1/runs': () => ({ items: [] }) })
    renderTab()
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument()
  })
})

describe('RunsTab — read-only graph', () => {
  it('lights the steps from the event journal', async () => {
    route(activeRoutes())
    renderTab()
    await openTechnical()
    await screen.findByText('Drafting the PRD')
    expect(await within(await screen.findByTestId('step-start')).findByLabelText('Done')).toBeInTheDocument()
    expect(within(screen.getByTestId('step-prd')).getByLabelText('Running')).toBeInTheDocument()
    expect(within(screen.getByTestId('step-end')).queryByLabelText(/Done|Running|Failed/)).not.toBeInTheDocument()
  })

  it('is labelled as the run graph, not the editor', async () => {
    route(activeRoutes())
    renderTab()
    await openTechnical()
    await screen.findByText('Drafting the PRD')
    expect(screen.getByLabelText('Run progress graph')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Steps' })).not.toBeInTheDocument()
  })
})

/** Run now, then Start run in its confirmation. */
async function startRunNow() {
  await screen.findByRole('list', { name: 'Runs' })
  await userEvent.click(screen.getByRole('button', { name: 'Run now' }))
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start run' }))
}

describe('RunsTab — controls', () => {
  it('cancels the active run (admin)', async () => {
    const cancel = vi.fn((_body: unknown) => run('run_1', 'cancelled'))
    route(activeRoutes({ 'POST /agents/ag_1/runs/run_1/cancel': cancel }))
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(undefined))
  })

  it('disables Run now while a run is active', async () => {
    route(activeRoutes())
    renderTab()
    await screen.findByRole('button', { name: 'Cancel run' })
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled()
  })

  it('starts a run (admin) and opens it', async () => {
    const start = vi.fn((_body: unknown) => run('run_2', 'queued'))
    route(idleRoutes({
      'POST /agents/ag_1/run': start,
      'GET /agents/ag_1/runs/run_2': () => run('run_2', 'queued'),
      'GET /agents/ag_1/runs/run_2/events?after=0': () => ({ items: [] }),
    }))
    renderTab()
    await startRunNow()
    await waitFor(() => expect(start).toHaveBeenCalledWith(undefined))
    await waitFor(() => expect(calledWith('/agents/ag_1/runs/run_2')).toBe(true))
  })

  it('explains a 409 on Run now', async () => {
    route(idleRoutes({ 'POST /agents/ag_1/run': () => { throw new Error('API Error: 409') } }))
    renderTab()
    await startRunNow()
    expect(await screen.findByRole('alert')).toHaveTextContent('A run is already in progress.')
  })

  it('reports another Run now failure generically', async () => {
    route(idleRoutes({ 'POST /agents/ag_1/run': () => { throw new Error('API Error: 500') } }))
    renderTab()
    await startRunNow()
    expect(await screen.findByRole('alert')).toHaveTextContent("The run couldn't be started.")
  })

  it('asks before Run now: the dialog names the agent, its workflow and scope, and Cancel starts nothing', async () => {
    const start = vi.fn((_body: unknown) => run('run_2', 'queued'))
    route(idleRoutes({ 'POST /agents/ag_1/run': start }))
    renderTab()
    await screen.findByRole('list', { name: 'Runs' })
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent(/AgentScout\s*WorkflowFlow\s*Feedback in scopeAll categories/))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('offers neither Run now nor Cancel to a non-admin', async () => {
    route(activeRoutes())
    renderTab(false)
    await screen.findByRole('list', { name: 'Runs' })
    await screen.findByText(/Working on/)
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument()
  })
})

describe('RunsTab — the plain-language summary comes first', () => {
  /** A finished run that produced one PRD in a named project. */
  const summaryRoutes = () => idleRoutes({
    'GET /agents/ag_1/runs/run_0': () => run('run_0', 'completed', { finished_at: '2026-10-04T09:20:00Z' }),
    'GET /agents/ag_1/runs/run_0/events?after=0': () => ({ items: [
      { seq: 1, at: '', kind: 'artifact', summary: 'PRD about technical_support delays', ref: { project_id: 'proj_7', document_id: 'doc_3' } },
    ] }),
    'GET /projects': () => ({ projects: [{ project_id: 'proj_7', name: 'Checkout revamp', created_at: '' }] }),
  })
  it('says what happened and what it produced, linked into the project by name', async () => {
    route(summaryRoutes())
    renderTab()
    const summary = await screen.findByRole('region', { name: 'What happened' })
    expect(summary).toHaveTextContent('Started by hand on Oct 4, 2026')
    expect(await within(summary).findByRole('link', { name: 'PRD about Technical support delays' }))
      .toHaveAttribute('href', '/projects/proj_7?tab=documents&doc=doc_3')
    await waitFor(() => expect(summary).toHaveTextContent('in Checkout revamp'))
  })

  it('ends with what needs you, and keeps the technical log closed', async () => {
    route(summaryRoutes())
    renderTab()
    const summary = await screen.findByRole('region', { name: 'What happened' })
    await waitFor(() => expect(summary).toHaveTextContent('Finished on Oct 4, 2026'))
    expect(summary).toHaveTextContent('Nothing — no action needed.')
    expect(screen.queryByRole('region', { name: 'Event log' })).not.toBeInTheDocument()
  })

  it('names the step a running run is on', async () => {
    route(activeRoutes())
    renderTab()
    expect(await screen.findByText('Working on “Write the PRD” now.')).toBeInTheDocument()
  })
})

describe('RunsTab — why a run failed', () => {
  const failedRoutes = (error: string) => idleRoutes({
    'GET /agents/ag_1/runs': () => ({ items: [run('run_0', 'failed', { error })] }),
    'GET /agents/ag_1/runs/run_0': () => run('run_0', 'failed', { error }),
    'GET /agents/ag_1/runs/run_0/events?after=0': () => ({ items: [
      { seq: 1, at: '', kind: 'node_failed', node_id: 'prd', summary: 'the review analysis was not valid JSON', detail: 'JSONDecodeError: Expecting value: line 1 column 1' },
    ] }),
  })

  it("shows the step's technical reason in the technical log only", async () => {
    route(failedRoutes('Write the PRD failed.'))
    renderTab()
    await screen.findByRole('alert')
    expect(screen.queryByText('JSONDecodeError: Expecting value: line 1 column 1')).toBeNull()
    await openTechnical()
    expect(await screen.findByText('JSONDecodeError: Expecting value: line 1 column 1')).toBeInTheDocument()
  })

  it('adds the failed step\'s reason from the journal to a summary that lacks it', async () => {
    route(failedRoutes('Write the PRD failed.'))
    renderTab()
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveTextContent('Reason: the review analysis was not valid JSON'))
  })

  it('does not repeat a reason the summary already names', async () => {
    route(failedRoutes('Write the PRD failed: the review analysis was not valid JSON.'))
    renderTab()
    await openTechnical()
    await screen.findAllByText('the review analysis was not valid JSON')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Reason:')
  })
})

describe('RunsTab — a failed run list is not "No runs yet"', () => {
  it('shows LoadFailed instead of the empty line, and recovers on Try again', async () => {
    const runsRead = vi.fn<Handler>(() => ({ items: [run('run_0', 'completed')] }))
    runsRead.mockImplementationOnce(() => { throw new Error('API Error: 500') })
    route(idleRoutes({ 'GET /agents/ag_1/runs': runsRead }))
    const user = userEvent.setup()
    renderTab()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(enCommon.loadFailed.message)
    expect(screen.queryByText(enAgents.run.none)).not.toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: enCommon.loadFailed.retry }))
    expect(await screen.findByRole('list', { name: 'Runs' })).toBeInTheDocument()
    expect(screen.queryByText(enCommon.loadFailed.message)).not.toBeInTheDocument()
  })

  it('an empty successful list still says "No runs yet"', async () => {
    route(idleRoutes({ 'GET /agents/ag_1/runs': () => ({ items: [] }) }))
    renderTab()
    expect(await screen.findByText(enAgents.run.none)).toBeInTheDocument()
    expect(screen.queryByText(enCommon.loadFailed.message)).not.toBeInTheDocument()
  })
})
