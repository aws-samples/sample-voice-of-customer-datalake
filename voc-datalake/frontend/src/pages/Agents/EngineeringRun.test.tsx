/**
 * @fileoverview The run monitor of an engineering run: its header (no cost yet), the flow with the agents' steps lit,
 * the Agents, Board and Conversation panels, an admin's signals (at the attempt the board shows; Stop now asks first;
 * a moved-on attempt says to reload) and answers (to the conductor, or on the thread replied to), a non-admin's
 * read-only view, and the page for a run that is not there.
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
import { liveSteps } from './engineeringRunText'
import { parseOverview } from '../../api/engineeringRunsApi'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: EngineeringRun } = await import('./EngineeringRun')

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

function renderRun(runId = 'RUN1') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[`/agents/engineering/${runId}`]}>
      <Routes><Route path="/agents/engineering/:runId" element={<EngineeringRun />} /></Routes>
    </TestRouter>,
  )
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('the run monitor', () => {
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
    const board = await screen.findByTestId('step-board')
    expect(board.className).toContain('border-accent')
    expect(screen.getByTestId('step-gate').className).not.toContain('border-accent')
    expect(screen.getByTestId('step-pr').className).not.toContain('border-accent')
  })

  it('shows its agents\' status, ages, the one that looks stuck, and an agent\'s recent tool calls', async () => {
    routes()
    renderRun()
    expect(await screen.findByText('Looks stuck: No progress for 10 minutes')).toBeInTheDocument()
    expect([screen.getByText('Waiting').tagName, screen.getByText('continuation 1').tagName]).toStrictEqual(['SPAN', 'SPAN'])
    expect(screen.getAllByText('30 sec ago')).toHaveLength(3)
    await userEvent.click(screen.getByText('Recent tool calls (2)'))
    expect(screen.getByText('run_tests')).toBeVisible()
  })

  it('groups the board by state, with each task\'s holder and attempt', async () => {
    routes()
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Board/ }))
    const inProgress = screen.getByRole('region', { name: 'In progress' })
    expect(within(inProgress).getByText(/attempt 2 · held by fixer-1/)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Open' })).getByText('Sorting ignores the time zone')).toBeInTheDocument()
  })

  it('shows the conversation in order', async () => {
    routes()
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Conversation/ }))
    const items = within(await screen.findByRole('list', { name: 'Conversation' })).getAllByRole('listitem')
    expect(items.map((item) => within(item).getByText(/^Message/).textContent)).toStrictEqual(['Message 1', 'Message 2'])
  })

  it('shows a run that is not there as not found', async () => {
    routes()
    renderRun('RUN9')
    expect(await screen.findByRole('heading', { name: 'Engineering run not found' })).toBeInTheDocument()
  })
})

describe('an admin acts on the run', () => {
  it('pauses the agent on a task at the attempt the board shows', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'pause', agents: { 'fixer-1': 'pause_requested' } } }))
    routes({ [`POST ${BASE}/signals`]: signal })
    renderRun()
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Pause — Agent fixer-1' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'pause', task_id: 'task-1', attempt: 2 }))
    expect(await screen.findByText('Sent. fixer-1: Pause requested')).toBeInTheDocument()
  })

  it('offers no signal for an agent whose task is over, though it keeps the lease', async () => {
    routes()
    renderRun()
    await screen.findByRole('group', { name: 'Agent fixer-1' })
    expect(screen.queryByRole('group', { name: 'Agent final-go-1' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Agent coordinator-0' })).toBeNull()
  })

  it('asks before Stop now, and sends it confirmed to the whole run', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'stop_now' } }))
    routes({ [`POST ${BASE}/signals`]: signal })
    renderRun()
    const run = await screen.findByRole('group', { name: 'The whole run' })
    await userEvent.click(within(run).getByRole('button', { name: 'Stop now — The whole run' }))
    const dialog = await screen.findByRole('dialog')
    expect(signal).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop now' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'stop_now', confirm: true }))
  })

  it('shows the server\'s reason for a conflict, and says to reload when it gave none', async () => {
    const reasons = ['run RUN1 has spent its budget: raise it before resuming']
    routes({ [`POST ${BASE}/signals`]: () => { throw new ApiError(409, reasons.shift()) } })
    renderRun()
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Resume — Agent fixer-1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('run RUN1 has spent its budget: raise it before resuming')
    await userEvent.click(within(fixer).getByRole('button', { name: 'Save — Agent fixer-1' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This has moved on since you looked'))
  })

  it('shows the 503 a busy agent answers, and nothing says it was sent', async () => {
    routes({ [`POST ${BASE}/signals`]: () => { throw new ApiError(503, 'The agent is busy with another move: send the signal again') } })
    renderRun()
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Pause — Agent fixer-1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The agent is busy with another move: send the signal again')
    expect(screen.queryByText(/^Sent\./)).toBeNull()
  })

  it('answers the conductor, then an agent on the thread it replies to', async () => {
    const answer = vi.fn((_body: unknown) => ({ message: { event_id: 'e', thread_id: 't', at: '' } }))
    routes({ [`POST ${BASE}/messages`]: answer })
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Conversation/ }))
    await userEvent.type(await screen.findByLabelText('Your message'), 'Skip the docs task')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ to: 'conductor', text: 'Skip the docs task' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Reply to fixer-1' })[0] ?? document.body)
    expect(screen.getByLabelText('Answer')).toHaveValue('fixer-1')
    await userEvent.type(screen.getByLabelText('Your message'), 'Yes, inclusive.')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(answer).toHaveBeenLastCalledWith({ to: 'agent', agent: 'fixer-1', text: 'Yes, inclusive.', thread_id: 't-7' }))
  })

  it('counts the bytes of an answer and holds one that is too long', async () => {
    routes()
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Conversation/ }))
    await userEvent.click(await screen.findByLabelText('Your message'))
    await userEvent.paste('é'.repeat(513))
    expect(screen.getByText('1,026 / 1,024 bytes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('who may act', () => {
  it('a non-admin sees the run with no signals and no composer', async () => {
    adminFlag.isAdmin = false
    routes()
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    expect(screen.queryByRole('group', { name: 'The whole run' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Agent fixer-1' })).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: /Conversation/ }))
    expect(screen.queryByLabelText('Your message')).toBeNull()
  })

  it('an ended run takes no more actions', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({ ended_at: '2026-11-12T09:30:00Z', status: 'completed' }) })
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    expect(screen.queryByRole('group', { name: 'The whole run' })).toBeNull()
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
