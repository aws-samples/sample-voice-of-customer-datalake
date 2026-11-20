/**
 * @fileoverview The run monitor of an engineering run, as the run workspace keeps it (7.51.00, RunWorkspace/): its
 * header (no cost yet), the flow with the agents' steps lit, an agent's session (why it looks stuck) and its facts in
 * the inspector's Cost tab, the inspector's Board and Reports (each report's versions, as Markdown only), an admin's
 * agent signals (at the attempt it is on; Stop now asks first; a moved-on attempt says to reload) and answers (to an
 * agent's own question, on its thread), the run's Stop (7.50.03: through the start function, there for an admin on any
 * run under way where the deployment names it, Stopping… while its agents save), who may act (where the deployment
 * does not connect the runtime and the bus, the composer is off and says why), polling (a failed read keeps the
 * controls) and the page for a run that is not there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { engineeringBoard, engineeringFlowView, engineeringMessage, engineeringOverview } from '@test/engineeringRunFixtures'
import { ApiError } from '../../lib/errors'
import { groupsInOrder, liveSteps } from './engineeringRunText'
import { parseOverview } from '../../api/engineeringRunsApi'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
// (the original kept beside the doubles: the shared safe-Markdown policy's links reach the assistant's store)
vi.mock('../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))

const { default: EngineeringRun } = await import('./RunWorkspace/RunWorkspace')

const BASE = '/agents/engineering/RUN1'

function routes(extra: Record<string, Handler> = {}) {
  route({
    [`GET ${BASE}`]: () => engineeringOverview(),
    [`GET ${BASE}/board`]: () => engineeringBoard(),
    [`GET ${BASE}/conversation?after=0`]: () => ({ items: [engineeringMessage(1), engineeringMessage(2)], next_after: 0 }),
    'GET /workflows/wf_flow': () => engineeringFlowView(),
    ...extra,
  })
}

function renderRun(runId = 'RUN1', agent = '') {
  const open = agent === '' ? '' : `/a/${agent}`
  return renderWithQueryClient(
    <TestRouter initialEntries={[`/agents/engineering/${runId}${open}`]}>
      <Routes><Route path="/agents/engineering/:runId/*" element={<EngineeringRun />} /></Routes>
    </TestRouter>,
  )
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('the run monitor', () => {
  it('shows the run\'s flow budget and the level its flow\'s month passed', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({ budget: { monthly_usd: 50, alert_percent: 100, alert_month: '2026-11' } }) })
    renderRun()
    expect(await screen.findByText('Flow budget: $50.00 a month')).toBeInTheDocument()
    expect(screen.getByText('November 2026: 100% of the budget spent')).toHaveClass('badge-danger')
  })

  it('marks a flag under 100% as a warning', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({ budget: { monthly_usd: 50, alert_percent: 80, alert_month: '2026-11' } }) })
    renderRun()
    expect(await screen.findByText('November 2026: 80% of the budget spent')).toHaveClass('badge-warn')
  })

  it('shows no budget line for a run with none', async () => {
    routes()
    renderRun()
    await screen.findByText('Fix the paging bugs')
    expect(screen.queryByText(/Flow budget/)).not.toBeInTheDocument()
  })

  it('shows the run, its MicroVM time and messages, and its tokens per model, with no cost yet', async () => {
    routes()
    renderRun()
    expect(await screen.findByRole('heading', { name: 'Fix the paging bugs' })).toBeInTheDocument()
    expect(screen.getByText('MicroVM time: 900 s · Messages: 3')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Tokens per model' })).getByText('model-a: 2,000 in, 400 out')).toBeInTheDocument()
    // No amount of money anywhere: the server has no cost yet.
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('lights the steps its agents are on, and no node for a step in the harness\'s own words', async () => {
    routes()
    renderRun()
    // (7.52.00: a step's state is its outline, `data-state`, beside its kind's shape)
    const board = await screen.findByTestId('step-board')
    expect(board).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('step-gate')).not.toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('step-pr')).not.toHaveAttribute('data-state', 'running')
  })

  it('draws the run\'s own copy of its flow, its steps lit as the conductor reads them', async () => {
    const copied = engineeringFlowView().workflow.definition
    routes({
      [`GET ${BASE}`]: () => engineeringOverview({
        flow_revision: 1, flow_definition: copied,
        flow_steps: { start: 'done', board: 'done', gate: 'blocked', pr: 'skipped', human: 'waiting' },
      }),
      // (the flow as saved since is not what the run follows: never read)
      'GET /workflows/wf_flow': () => { throw new Error('the saved flow was read') },
    })
    renderRun()
    const gate = await screen.findByTestId('step-gate')
    expect(gate).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('step-board')).toHaveAttribute('data-state', 'done')
    // (a way not taken: dotted, never dimmed by opacity)
    expect(screen.getByTestId('step-pr')).toHaveAttribute('data-state', 'skipped')
    expect(screen.getByTestId('step-pr').className).not.toContain('opacity-')
  })

  it('says in an agent\'s session why it looks stuck, and shows its session\'s facts in the Cost tab', async () => {
    routes()
    renderRun('RUN1', 'final-go-1')
    expect(await screen.findByText('Looks stuck: No progress for 10 minutes')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Cost' }))
    const cost = within(screen.getByRole('tabpanel', { name: 'Cost' }))
    expect([cost.getByText('Reading the review rounds').tagName, cost.getByText('30 sec ago').tagName]).toStrictEqual(['DD', 'DD'])
  })

  it('groups the board by state, with each task\'s holder and attempt', async () => {
    routes()
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Board/ }))
    const inProgress = screen.getByRole('region', { name: 'In progress' })
    expect(within(inProgress).getByText(/attempt 2 · held by fixer-1/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Open' })).getByText('Sorting ignores the time zone')).toBeInTheDocument()
  })

  it('shows a run that is not there as not found', async () => {
    routes()
    renderRun('RUN9')
    expect(await screen.findByRole('heading', { name: 'Engineering run not found' })).toBeInTheDocument()
  })
})

describe('the reports', () => {
  const SHA = 'a'.repeat(40)
  const index = () => ({ items: [
    { level: 'commit', subject: SHA, latest_version: 1 },
    { level: 'goal', subject: 'RUN1', latest_version: 2 },
    { level: 'later', subject: 'x' },   // (a bad entry costs itself)
  ] })
  const report = (version: number) => ({ report: { version, built_at: '2026-11-12T09:00:00Z' },
    markdown: `# Goal report\n\nVersion ${version}\n\n<script>alert(1)</script>` })

  const openGoal = async (extra: Record<string, Handler> = {}) => {
    routes({ [`GET ${BASE}/reports`]: index, [`GET ${BASE}/reports/goal/RUN1?version=2`]: () => report(2), ...extra })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Reports/ }))
    const goal = await screen.findByRole('region', { name: 'Goal' })
    await userEvent.click(within(goal).getByRole('button', { name: 'RUN1 (v2)' }))
    await screen.findByText('Version 2')
  }

  it('lists them by level, goal first, and shows the latest version of the one chosen as Markdown only', async () => {
    await openGoal()
    const levels = within(screen.getByRole('tabpanel', { name: 'Reports' })).getAllByRole('region')
    expect(levels.map((region) => region.getAttribute('aria-label')).slice(0, 2)).toStrictEqual(['Goal', 'Commits'])
    expect(within(screen.getByRole('region', { name: 'Commits' })).getByText(`${SHA} (v1)`)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Goal report' })).toBeInTheDocument()
    // Markdown only: the raw HTML in a report is never rendered.
    expect(document.querySelector('script')).toBeNull()
  })

  it('reads an earlier version when it is picked, once', async () => {
    const first = vi.fn(() => report(1))
    await openGoal({ [`GET ${BASE}/reports/goal/RUN1?version=1`]: first })
    await userEvent.selectOptions(screen.getByLabelText('Version'), 'v1')
    expect(await screen.findByText('Version 1')).toBeInTheDocument()
    expect(first.mock.calls).toHaveLength(1)
  })

  it('says when no report is written yet', async () => {
    routes({ [`GET ${BASE}/reports`]: () => ({ items: [] }) })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Reports/ }))
    expect(await screen.findByText('No report has been written yet.')).toBeInTheDocument()
  })

  it('says an earlier version that was never written (404) is so, with no retry', async () => {
    await openGoal({ [`GET ${BASE}/reports/goal/RUN1?version=1`]: () => { throw new ApiError(404, 'no') } })
    await userEvent.selectOptions(screen.getByLabelText('Version'), 'v1')
    expect(await screen.findByText(/This version was never written/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry|Try again/ })).toBeNull()
  })

  it('reads a 404 of the latest version (which was written) as a failed read, with a retry', async () => {
    routes({
      [`GET ${BASE}/reports`]: index,
      [`GET ${BASE}/reports/commit/${SHA}?version=1`]: () => { throw new ApiError(404, 'no') },
    })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Reports/ }))
    await userEvent.click(await screen.findByRole('button', { name: `${SHA} (v1)` }))
    expect(await screen.findByText(/This report could not be read/)).toBeInTheDocument()
    expect(screen.queryByText(/never written/)).toBeNull()
  })

  it('lists a level the page does not know after the known ones, by its name', async () => {
    routes({ [`GET ${BASE}/reports`]: () => ({ items: [...index().items, { level: 'audit', subject: 'x', latest_version: 1 }] }) })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Reports/ }))
    await screen.findByRole('region', { name: 'audit' })
    const levels = within(screen.getByRole('tabpanel', { name: 'Reports' })).getAllByRole('region')
    expect(levels.map((region) => region.getAttribute('aria-label'))).toStrictEqual(['Goal', 'Commits', 'audit'])
  })
})

describe('the reports while the run is under way', () => {
  afterEach(() => { vi.useRealTimers() })

  it('keeps the version on screen when a newer one is written, says so, and shows it when asked (7.52.00)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const index = { latest: 2 }
    const gate: { open?: () => void } = {}
    const third = { promise: new Promise<void>((resolve) => { gate.open = resolve }) }
    const report = (version: number) => ({ report: { built_at: '' }, markdown: `Version ${version}` })
    routes({
      [`GET ${BASE}/reports`]: () => ({ items: [{ level: 'goal', subject: 'RUN1', latest_version: index.latest }] }),
      [`GET ${BASE}/reports/goal/RUN1?version=2`]: () => report(2),
      [`GET ${BASE}/reports/goal/RUN1?version=3`]: async () => { await third.promise; return report(3) },
    })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Reports/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'RUN1 (v2)' }))
    await screen.findByText('Version 2')
    index.latest = 3
    await vi.advanceTimersByTimeAsync(16_000)
    expect([await screen.findByRole('option', { name: 'Latest (v3)' }), screen.getByText('Version 2'),
      screen.getByText('A newer version is ready: v3.')]).toHaveLength(3)
    gate.open?.()
    await userEvent.click(screen.getByRole('button', { name: 'Show v3' }))
    expect(await screen.findByText('Version 3')).toBeInTheDocument()
  })
})

describe('an admin acts on the run and its agents', () => {
  const FIXER_THREAD = `${BASE}/agents/fixer-1/thread?limit=200`
  const question = { ref: 'c1', at: '2026-11-12T08:40:00Z', kind: 'message', from: { kind: 'agent', id: 'fixer-1' }, text: 'Message 1', cut: false, update: '' }

  it('stops an agent on its task at the attempt it is on, and says what it did', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'shutdown', agents: { 'fixer-1': 'stopped' }, applied: { 'fixer-1': true } } }))
    routes({ [`POST ${BASE}/signals`]: signal })
    renderRun('RUN1', 'fixer-1')
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'shutdown', task_id: 'task-1', attempt: 2 }))
    expect(await screen.findByText('Sent.')).toBeInTheDocument()
  })

  it('reads the run again after a signal, but not its reports (a signal writes none)', async () => {
    const reads = vi.fn(() => ({ items: [] }))
    routes({
      [`POST ${BASE}/signals`]: () => ({ signal: { event_id: 'e', signal: 'save', agents: {}, applied: {} } }),
      [`GET ${BASE}/reports`]: reads,
    })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Reports/ }))
    await screen.findByText('No report has been written yet.')
    const overviewReads = () => fetchApi.mock.calls.filter(([endpoint]) => endpoint === BASE).length
    const before = overviewReads()
    await userEvent.click(screen.getByRole('button', { name: 'More run controls' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save a checkpoint' }))
    await waitFor(() => expect(overviewReads()).toBeGreaterThan(before))
    expect(reads.mock.calls).toHaveLength(1)
  })

  it('says which agents a signal did nothing to', async () => {
    routes({ [`POST ${BASE}/signals`]: () => ({ signal: { event_id: 'e', signal: 'pause', agents: { 'fixer-1': 'working' }, applied: { 'fixer-1': false } } }) })
    renderRun()
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByText('Sent. · fixer-1: Working (not applied)')).toBeInTheDocument()
  })

  it('offers no signal for an agent whose task is over, nor for the orchestrator', async () => {
    routes()
    const first = renderRun('RUN1', 'final-go-1')
    await screen.findByText('Looks stuck: No progress for 10 minutes')
    expect(screen.queryByRole('group', { name: 'Agent final-go-1' })).toBeNull()
    first.unmount()
    renderRun()
    await screen.findByRole('tab', { name: 'Orchestrator' })
    expect(screen.queryByRole('group', { name: /^Agent / })).toBeNull()
  })

  it('asks before an agent\'s Stop now, and sends it confirmed on its task', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'stop_now' } }))
    routes({ [`POST ${BASE}/signals`]: signal })
    renderRun('RUN1', 'fixer-1')
    await userEvent.click(await screen.findByRole('button', { name: 'More for fixer-1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Stop now, without saving…' }))
    const dialog = await screen.findByRole('dialog')
    expect(signal).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop now, without saving' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'stop_now', confirm: true, task_id: 'task-1', attempt: 2 }))
  })

  it('shows the server\'s reason for a conflict, and says to reload when it gave none', async () => {
    const reasons = ['run RUN1 has spent its budget: raise it before resuming']
    routes({ [`POST ${BASE}/signals`]: () => { throw new ApiError(409, reasons.shift()) } })
    renderRun('RUN1', 'fixer-1')
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('run RUN1 has spent its budget: raise it before resuming')
    await userEvent.click(within(fixer).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This has moved on since you looked'))
  })

  it('shows the 503 a busy agent answers, and nothing says it was sent', async () => {
    routes({ [`POST ${BASE}/signals`]: () => { throw new ApiError(503, 'The agent is busy with another move: send the signal again') } })
    renderRun('RUN1', 'fixer-1')
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The agent is busy with another move: send the signal again')
    expect(screen.queryByText(/^Sent\./)).toBeNull()
  })

  it('answers an agent\'s own question from its thread, on the thread the question opened', async () => {
    const answer = vi.fn((_body: unknown) => ({ message: { event_id: 'e', thread_id: 't-7', at: '' } }))
    routes({ [`POST ${BASE}/messages`]: answer, [`GET ${FIXER_THREAD}`]: () => ({ items: [question], next: null, done: false }) })
    renderRun('RUN1', 'fixer-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Reply to fixer-1' }))
    await userEvent.type(screen.getByLabelText('Your message'), 'Yes, inclusive.')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ to: 'agent', agent: 'fixer-1', text: 'Yes, inclusive.', thread_id: 't-7' }))
  })

  it('counts the bytes of an answer and holds one that is too long', async () => {
    routes({ [`GET ${FIXER_THREAD}`]: () => ({ items: [question], next: null, done: false }) })
    renderRun('RUN1', 'fixer-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Reply to fixer-1' }))
    await userEvent.click(screen.getByLabelText('Your message'))
    await userEvent.paste('é'.repeat(513))
    expect(screen.getByText('1,026 / 1,024 bytes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('the run\'s Stop (7.50.03)', () => {
  /** A run waiting for a person whose coordinator never started, in a deployment the signals cannot reach. */
  const stuck = () => {
    const overview = engineeringOverview({ status: 'needs_human', waiting_at: 'coordinator' }, { steer: false, signals: false })
    overview.agents = []
    return overview
  }
  const controls = () => screen.findByRole('region', { name: 'Run controls' })

  it('stops a run waiting for a person with no session, where the signals cannot reach it, says so and reads it again', async () => {
    const run = { stopped: false }
    const stop = vi.fn((_body: unknown) => {
      run.stopped = true
      return { stop: { status: 'stopped', mode: 'stop', tasks_closed: ['coordinate'],
        agent_run: { agent_id: 'ag_1', run_id: 'ar_1', ended: true } } }
    })
    routes({
      [`GET ${BASE}`]: () => (run.stopped ? { ...stuck(), run: { ...stuck().run, status: 'stopped', ended_at: '2026-11-17T06:00:00Z' } } : stuck()),
      [`POST ${BASE}/stop`]: stop,
    })
    renderRun()
    const bar = within(await controls())
    expect(bar.getByText('Needs a person')).toHaveClass('badge-warn')
    // Stop is there although the workspace cannot send signals; Pause, Resume and Save are not, and the bar says why.
    expect([bar.queryByText(/Pause, Resume and Save can't reach this run from this deployment/) !== null,
      bar.queryByRole('button', { name: /Resume|Pause/ })]).toStrictEqual([true, null])
    const overviewReads = () => fetchApi.mock.calls.filter(([endpoint]) => endpoint === BASE).length
    const before = overviewReads()
    await userEvent.click(bar.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith({}))
    // Read again: the run has ended (its chip says so, Stop is gone), and what the Stop did stays said.
    const chip = await bar.findByText('Stopped')
    expect([chip.classList.contains('badge-muted'), overviewReads() > before, bar.queryByRole('button', { name: 'Stop' }),
      bar.queryByText("Stopped. 1 open task was closed. Its automation's run is cancelled, so the automation can run again.") !== null])
      .toStrictEqual([true, true, null, true])
  })

  it('shows a Stop under way as Stopping…, Stop inert, and each agent\'s part of it, and signals no agent', async () => {
    const stop = vi.fn((_body: unknown) => ({ stop: { status: 'stopping' } }))
    const stopping = engineeringOverview({ stop: { mode: 'stop', requested_at: '2026-11-17T05:00:00Z' } })
    stopping.agents = stopping.agents.map((agent) => (agent.agent === 'fixer-1' ? { ...agent, status: 'pause_requested' }
      : { ...agent, status: 'stopped' }))
    routes({ [`GET ${BASE}`]: () => stopping, [`POST ${BASE}/stop`]: stop })
    renderRun('RUN1', 'fixer-1')
    const bar = within(await controls())
    expect(bar.getByText('Stopping…')).toHaveClass('badge-warn')
    const button = bar.getByRole('button', { name: 'Stop' })
    await userEvent.click(button)
    expect([button.getAttribute('aria-disabled'), stop.mock.calls.length]).toStrictEqual(['true', 0])
    expect(bar.getByText('Stop sent · coordinator-0: Stopped · fixer-1 saving a checkpoint… · final-go-1: Stopped'))
      .toBeInTheDocument()
    // While it stops, no agent is signalled, nothing is steered, and Pause/Resume are gone.
    expect([screen.queryByRole('group', { name: 'Agent fixer-1' }), bar.queryByRole('button', { name: 'Pause' }),
      screen.queryByRole('textbox', { name: 'Steer the orchestrator' })]).toStrictEqual([null, null, null])
  })

  it('asks before Stop now, without saving, and sends it confirmed as the run\'s Stop', async () => {
    const stop = vi.fn((_body: unknown) => ({ stop: { status: 'stopped', mode: 'stop_now', tasks_closed: ['task-1', 'task-2'] } }))
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'stop_now' } }))
    routes({ [`POST ${BASE}/stop`]: stop, [`POST ${BASE}/signals`]: signal })
    renderRun()
    const bar = within(await controls())
    await userEvent.click(bar.getByRole('button', { name: 'More ways to stop' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop now, without saving…' }))
    const dialog = await screen.findByRole('dialog')
    expect(stop).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop now, without saving' }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ now: true, confirm: true }))
    expect([await bar.findByText('Stopped. 2 open tasks were closed.'), signal.mock.calls]).toStrictEqual([expect.anything(), []])
  })

  it('offers Resume for a run waiting for a person where the signals reach it', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'resume', agents: {}, applied: {} } }))
    routes({ [`GET ${BASE}`]: () => engineeringOverview({ status: 'needs_human', waiting_at: 'budget' }),
      [`POST ${BASE}/signals`]: signal })
    renderRun()
    await userEvent.click(within(await controls()).getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'resume' }))
  })

  it('says why the Stop was refused', async () => {
    routes({ [`POST ${BASE}/stop`]: () => { throw new ApiError(503, 'The run could not be reached: send the Stop again') } })
    renderRun()
    const bar = within(await controls())
    await userEvent.click(bar.getByRole('button', { name: 'Stop' }))
    expect(await bar.findByRole('alert')).toHaveTextContent('The run could not be reached: send the Stop again')
  })

  it('says where the deployment cannot stop the run', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({}, { steer: false, signals: false, stop: false }) })
    renderRun()
    const bar = within(await controls())
    expect(bar.getByText(/Stop can't reach this run from this deployment/)).toBeInTheDocument()
    expect(bar.queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})

describe('the board', () => {
  it('is read only, for an admin on a live run too (7.58.00: a person\'s board actions never reached a run)', async () => {
    routes()
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    await expectNoBoardControls()
    expect(screen.queryByRole('group', { name: 'Task Sorting ignores the time zone' })).toBeNull()
  })
})

/** The Board tab shows the tasks, with no Post and no Take. */
async function expectNoBoardControls() {
  await userEvent.click(screen.getByRole('tab', { name: /Board/ }))
  await screen.findByText('Sorting ignores the time zone')
  expect([screen.queryByText('Post a task'), screen.queryByRole('button', { name: 'Take' })]).toStrictEqual([null, null])
}

describe('who may act', () => {
  it('a non-admin sees the run with no controls, no composer and no board actions', async () => {
    adminFlag.isAdmin = false
    routes()
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    expect([screen.queryByRole('button', { name: 'Stop' }), screen.queryByRole('textbox', { name: 'Steer the orchestrator' })]).toStrictEqual([null, null])
    await expectNoBoardControls()
  })

  /** An agent's own question in its thread, which a Reply answers. */
  const question = { ref: 'c1', at: '2026-11-12T08:40:00Z', kind: 'message', from: { kind: 'agent', id: 'fixer-1' }, text: 'Message 1', cut: false, update: '' }

  it('an admin, where neither the signals nor the bus reach the run, still has Stop, and is told why the rest is off', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({}, { steer: false, signals: false }),
      [`GET ${BASE}/agents/fixer-1/thread?limit=200`]: () => ({ items: [question], next: null, done: false }) })
    renderRun('RUN1', 'fixer-1')
    await screen.findByRole('button', { name: 'Stop' })
    expect(screen.getByText(/Pause, Resume and Save can't reach this run from this deployment/)).toBeInTheDocument()
    // (the composer and Reply go over the bus, so the composer is off and says why; no Reply, no agent signal)
    const composer = await screen.findByRole('textbox', { name: 'Steer the orchestrator' })
    expect(composer).toHaveAccessibleDescription(/Steering and replies can't be sent from this deployment: it doesn't name the engineering bus/)
    await screen.findByText('Message 1')
    expect([composer.hasAttribute('disabled'), screen.queryByRole('button', { name: 'Pause' }),
      screen.queryByRole('button', { name: 'Reply to fixer-1' }), screen.queryByRole('group', { name: 'Agent fixer-1' })])
      .toStrictEqual([true, null, null, null])
    await expectNoBoardControls()
  })

  it('shows each control by its own flag (7.51.02): the signals without the bus, steering and Reply without the signals', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({}, { steer: false }),
      [`GET ${BASE}/agents/fixer-1/thread?limit=200`]: () => ({ items: [question], next: null, done: false }) })
    const signalled = renderRun('RUN1', 'fixer-1')
    // The signals reach the run (the start function): Pause, Save and the agent's own controls; the composer is off.
    await screen.findByRole('button', { name: 'Pause' })
    await screen.findByText('Message 1')
    expect([screen.queryByRole('group', { name: 'Agent fixer-1' }) !== null, screen.queryByText(/Pause, Resume and Save can't reach/),
      screen.getByRole('textbox', { name: 'Steer the orchestrator' }).hasAttribute('disabled'),
      screen.queryByRole('button', { name: 'Reply to fixer-1' })]).toStrictEqual([true, null, true, null])
    signalled.unmount()
    routes({ [`GET ${BASE}`]: () => engineeringOverview({}, { signals: false }),
      [`GET ${BASE}/agents/fixer-1/thread?limit=200`]: () => ({ items: [question], next: null, done: false }) })
    renderRun('RUN1', 'fixer-1')
    // Steering reaches it (the bus): the composer and Reply are on; Pause, Save and the agent's controls are not.
    const composer = await screen.findByRole('textbox', { name: 'Steer the orchestrator' })
    await screen.findByRole('button', { name: 'Reply to fixer-1' })
    expect([composer.hasAttribute('disabled'), screen.queryByRole('button', { name: 'Pause' }),
      screen.queryByRole('group', { name: 'Agent fixer-1' }), screen.queryByText(/Pause, Resume and Save can't reach/) !== null])
      .toStrictEqual([false, null, null, true])
    await expectNoBoardControls()
  })

  it('reads an overview that does not say what reaches the run as reaching none of it', () => {
    const unsaid = parseOverview({ ...engineeringOverview(), steer_available: undefined, signals_available: undefined,
      stop_available: undefined })
    expect([unsaid.steer_available, unsaid.signals_available, unsaid.stop_available]).toStrictEqual([false, false, false])
    const said = parseOverview(engineeringOverview())
    expect([said.steer_available, said.signals_available, said.stop_available]).toStrictEqual([true, true, true])
  })

  it('an ended run takes no more signals: Restart run instead', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({ ended_at: '2026-11-12T09:30:00Z', status: 'completed' }) })
    renderRun()
    expect(await screen.findByRole('button', { name: 'Restart run' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    await expectNoBoardControls()
  })
})

describe('groupsInOrder', () => {
  it('keeps the page\'s order for the groups present, then the unknown ones by name, each once', () => {
    expect(groupsInOrder(['goal', 'pr', 'commit'], ['commit', 'later', 'goal', 'commit', 'audit']))
      .toStrictEqual(['goal', 'commit', 'audit', 'later'])
  })
})

describe('liveSteps', () => {
  it('lights each node with an agent on it once, and nothing for a step that is no node', () => {
    const { agents } = parseOverview(engineeringOverview())
    expect([...liveSteps(agents, new Set(['start', 'board', 'gate'])).entries()]).toStrictEqual([
      ['board', { status: 'running', rounds: 1 }],
    ])
    expect(liveSteps(agents, new Set()).size).toBe(0)
  })

  it('lights each step as the conductor reads it when the run follows its flow, and leaves the unknown ones', () => {
    const { agents } = parseOverview(engineeringOverview())
    const steps = { start: 'done', board: 'collecting', gate: 'human', pr: 'not_yet_run', human: 'waiting', x: 'done',
      odd: 'teleported', fix: 'blocked', learn: 'skipped', commit: 'stopped' }
    const ids = new Set(['start', 'board', 'gate', 'pr', 'human', 'odd', 'fix', 'learn', 'commit'])
    // (7.51.04: a step at a person waits for one, a stopped one is stopped and a way not taken skipped, never a failure)
    expect(Object.fromEntries([...liveSteps(agents, ids, steps)].map(([step, state]) => [step, state.status]))).toStrictEqual(
      { start: 'done', board: 'running', gate: 'waiting', pr: 'idle', fix: 'failed', learn: 'skipped', commit: 'stopped' })
  })

  it('reads a run with no flow copy as none', () => {
    const { run } = parseOverview(engineeringOverview({ flow_steps: 'nope', flow_revision: -1, flow_definition: 'x' }))
    expect([run.flow_steps, run.flow_revision, run.flow_definition]).toStrictEqual([null, null, null])
    expect(parseOverview(engineeringOverview()).run.flow_steps).toBeNull()
  })
})

describe('polling', () => {
  afterEach(() => { vi.useRealTimers() })

  it('reads again while the run is under way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    routes()
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    const overviewReads = () => fetchApi.mock.calls.filter(([endpoint]) => endpoint === BASE).length
    const before = overviewReads()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(overviewReads()).toBeGreaterThan(before)
  })

  it('keeps the controls after a failed read, says so, and reads again later and on Retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fail = () => { throw new Error('API Error: 500') }
    const answers: Array<() => unknown> = [() => engineeringOverview(), fail, fail]
    routes({ [`GET ${BASE}`]: () => (answers.shift() ?? (() => engineeringOverview()))() })
    renderRun()
    await screen.findByRole('button', { name: 'Stop' })
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await screen.findByText(/Couldn't refresh this run/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh this run/)).toBeNull())
  })

  it('stops once the run is not found', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    routes()
    renderRun('RUN9')
    await screen.findByRole('heading', { name: 'Engineering run not found' })
    const reads = fetchApi.mock.calls.length
    await vi.advanceTimersByTimeAsync(11_000)
    expect(fetchApi.mock.calls).toHaveLength(reads)
  })
})
