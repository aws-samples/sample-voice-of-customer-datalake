/**
 * @fileoverview The run monitor of an engineering run: its header (no cost yet), the flow with the agents' steps lit,
 * the Agents, Board, Conversation and Reports panels (each report's versions, as Markdown only), an admin's signals (at the attempt the board shows; Stop now asks first;
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
import { groupsInOrder, liveSteps } from './engineeringRunText'
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
    const levels = within(screen.getByRole('tabpanel')).getAllByRole('region')
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
    const levels = within(screen.getByRole('tabpanel')).getAllByRole('region')
    expect(levels.map((region) => region.getAttribute('aria-label'))).toStrictEqual(['Goal', 'Commits', 'audit'])
  })
})

describe('the reports while the run is under way', () => {
  afterEach(() => { vi.useRealTimers() })

  it('follows the latest: a newer version the index shows is read, the one on screen kept until it comes', async () => {
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
    expect([await screen.findByRole('option', { name: 'Latest (v3)' }), screen.getByText('Version 2')]).toHaveLength(2)
    gate.open?.()
    expect(await screen.findByText('Version 3')).toBeInTheDocument()
  })
})

describe('an admin acts on the run', () => {
  it('pauses the agent on a task at the attempt the board shows', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'pause', agents: { 'fixer-1': 'pause_requested' }, applied: { 'fixer-1': true } } }))
    routes({ [`POST ${BASE}/signals`]: signal })
    renderRun()
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Pause — Agent fixer-1' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'pause', task_id: 'task-1', attempt: 2 }))
    expect(await screen.findByText('Sent. fixer-1: Pause requested')).toBeInTheDocument()
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
    const run = screen.getByRole('group', { name: 'The whole run' })
    await userEvent.click(within(run).getByRole('button', { name: 'Save — The whole run' }))
    await waitFor(() => expect(overviewReads()).toBeGreaterThan(before))
    expect(reads.mock.calls).toHaveLength(1)
  })

  it('says which agents a signal did nothing to', async () => {
    const signal = vi.fn((_body: unknown) => ({ signal: { event_id: 'e', signal: 'resume', agents: { 'fixer-1': 'working' }, applied: { 'fixer-1': false } } }))
    routes({ [`POST ${BASE}/signals`]: signal })
    renderRun()
    const fixer = await screen.findByRole('group', { name: 'Agent fixer-1' })
    await userEvent.click(within(fixer).getByRole('button', { name: 'Resume — Agent fixer-1' }))
    expect(await screen.findByText('Sent. fixer-1: Working (not applied)')).toBeInTheDocument()
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

describe('an admin acts on the board', () => {
  type Task = ReturnType<typeof engineeringBoard>['tasks'][number]
  const boardWith = (change: (tasks: Task[]) => Task[]) => () => ({ tasks: change(engineeringBoard().tasks) })
  const held = (by: string, state = 'claimed') => boardWith((tasks) => tasks.map((task) => (task.task_id === 'task-2'
    ? { ...task, state, lease: { agent: by, epoch: 0, expires: 253402300799 } } : task)))
  const openBoard = async (extra: Record<string, Handler> = {}) => {
    routes(extra)
    renderRun()
    await userEvent.click(await screen.findByRole('tab', { name: /Board/ }))
    return screen.findByRole('group', { name: 'Task Sorting ignores the time zone' })
  }

  it('posts a task for a role, with what to do', async () => {
    const posted = vi.fn((_body: unknown) => ({ task: {} }))
    await openBoard({ [`POST ${BASE}/board/tasks`]: posted })
    await userEvent.click(screen.getByText('Post a task'))
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'hunter')
    await userEvent.type(screen.getByLabelText('Title'), ' Look at the export ')
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('What to do'), 'Check the CSV export')
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(posted).toHaveBeenCalledWith(
      { role: 'hunter', title: 'Look at the export', spec: { instructions: 'Check the CSV export' } }))
    expect(await screen.findByText('Posted.')).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('')
  })

  it('takes an open task, blocks it with a reason and sets its priority', async () => {
    const calls = { take: vi.fn((_b: unknown) => ({})), block: vi.fn((_b: unknown) => ({})), priority: vi.fn((_b: unknown) => ({})) }
    const group = await openBoard({
      [`POST ${BASE}/board/tasks/task-2/take`]: calls.take,
      [`POST ${BASE}/board/tasks/task-2/block`]: calls.block,
      [`POST ${BASE}/board/tasks/task-2/priority`]: calls.priority,
    })
    await userEvent.click(within(group).getByRole('button', { name: 'Take' }))
    await waitFor(() => expect(calls.take).toHaveBeenCalledWith({}))
    await userEvent.click(within(group).getByRole('button', { name: 'Block' }))
    await userEvent.type(screen.getByLabelText('Why'), 'Wrong repository')
    await userEvent.click(screen.getByRole('button', { name: 'Block the task' }))
    await waitFor(() => expect(calls.block).toHaveBeenCalledWith({ reason: 'Wrong repository' }))
    const priority = within(group).getByLabelText('Priority')
    expect(within(group).getByRole('button', { name: 'Set priority' })).toBeDisabled()
    await userEvent.clear(priority)
    await userEvent.type(priority, '5')
    await userEvent.click(within(group).getByRole('button', { name: 'Set priority' }))
    await waitFor(() => expect(calls.priority).toHaveBeenCalledWith({ priority: 5 }))
  })

  it('moves a task the admin holds, and offers no Take on it', async () => {
    const move = vi.fn((_b: unknown) => ({}))
    const group = await openBoard({ [`GET ${BASE}/board`]: held('human:admin-sub'), [`POST ${BASE}/board/tasks/task-2/move`]: move })
    expect(within(group).queryByRole('button', { name: /^Take/ })).toBeNull()
    expect(within(group).getAllByRole('button', { name: /^Move to/ }).map((button) => button.textContent))
      .toStrictEqual(['Move to In progress', 'Move to Failed'])   // (to "needs a person" only by Block, with a reason)
    await userEvent.click(within(group).getByRole('button', { name: 'Move to In progress' }))
    await waitFor(() => expect(move).toHaveBeenCalledWith({ to: 'in_progress' }))
  })

  it('gives a task the admin holds back to the agents', async () => {
    const release = vi.fn((_b: unknown) => ({}))
    const group = await openBoard({ [`GET ${BASE}/board`]: held('human:admin-sub'), [`POST ${BASE}/board/tasks/task-2/release`]: release })
    await userEvent.click(within(group).getByRole('button', { name: 'Give back to the agents' }))
    await waitFor(() => expect(release).toHaveBeenCalledWith({}))
  })

  it('asks before taking over another person\'s task, and sends it as a take over', async () => {
    const take = vi.fn((_b: unknown) => ({}))
    const group = await openBoard({ [`GET ${BASE}/board`]: held('human:other-sub'), [`POST ${BASE}/board/tasks/task-2/take`]: take })
    expect(within(group).queryByRole('button', { name: /^Move to/ })).toBeNull()
    await userEvent.click(within(group).getByRole('button', { name: 'Take over' }))
    const dialog = await screen.findByRole('dialog')
    expect([within(dialog).getByText(/other-sub/), take.mock.calls]).toStrictEqual([expect.anything(), []])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Take over' }))
    await waitFor(() => expect(take).toHaveBeenCalledWith({ over: true }))
  })

  it('asks before blocking another person\'s task, and sends the block with over', async () => {
    const block = vi.fn((_b: unknown) => ({}))
    const group = await openBoard({ [`GET ${BASE}/board`]: held('human:other-sub'), [`POST ${BASE}/board/tasks/task-2/block`]: block })
    await userEvent.click(within(group).getByRole('button', { name: 'Block' }))
    await userEvent.type(screen.getByLabelText('Why'), 'Wrong repository')
    await userEvent.click(screen.getByRole('button', { name: 'Block the task' }))
    const dialog = await screen.findByRole('dialog')
    expect([within(dialog).getByText(/blocking it ends their hold/), block.mock.calls]).toStrictEqual([expect.anything(), []])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Block the task' }))
    await waitFor(() => expect(block).toHaveBeenCalledWith({ reason: 'Wrong repository', over: true }))
  })

  it('says a post that found an equal task posted nothing, and keeps what was typed', async () => {
    await openBoard({ [`POST ${BASE}/board/tasks`]: () => ({ task: {}, duplicate: true }) })
    await userEvent.click(screen.getByText('Post a task'))
    await userEvent.type(screen.getByLabelText('Title'), 'Look at the export')
    await userEvent.type(screen.getByLabelText('What to do'), 'Check the CSV export')
    await userEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(await screen.findByText('An equal task is already on the board: nothing new was posted.')).toBeInTheDocument()
    expect([screen.queryByText('Posted.'), screen.getByLabelText('Title')]).toStrictEqual([null, expect.anything()])
    expect(screen.getByLabelText('Title')).toHaveValue('Look at the export')
  })

  it('sets no priority from an empty field', async () => {
    const group = await openBoard()
    await userEvent.clear(within(group).getByLabelText('Priority'))
    expect(within(group).getByRole('button', { name: 'Set priority' })).toBeDisabled()
  })

  it('shows why an action was refused', async () => {
    const group = await openBoard({
      [`POST ${BASE}/board/tasks/task-2/take`]: () => { throw new ApiError(409, 'the task has moved on: reload the board') },
    })
    await userEvent.click(within(group).getByRole('button', { name: 'Take' }))
    expect(await within(group.parentElement ?? document.body).findByRole('alert'))
      .toHaveTextContent('the task has moved on: reload the board')
  })

  it('offers no controls on a task that has ended or on the coordinator\'s task', async () => {
    await openBoard({ [`GET ${BASE}/board`]: boardWith((tasks) => [
      ...tasks, ...tasks.filter((task) => task.task_id === 'task-2').map((task) => ({ ...task, task_id: 'coordinate', title: 'Coordinate' })),
    ]) })
    expect(screen.queryByRole('group', { name: 'Task The gate record for the page fix' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Task Coordinate' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Task The last page shows one item too many' })).toBeInTheDocument()
  })
})

/** The Board tab shows the tasks, with no Post and no Take. */
async function expectNoBoardControls() {
  await userEvent.click(screen.getByRole('tab', { name: /Board/ }))
  await screen.findByText('Sorting ignores the time zone')
  expect([screen.queryByText('Post a task'), screen.queryByRole('button', { name: 'Take' })]).toStrictEqual([null, null])
}

describe('who may act', () => {
  it.each([
    { who: 'a non-admin', admin: false, available: true, told: false },
    { who: 'an admin, where the monitor cannot reach the run,', admin: true, available: false, told: true },
  ])('$who sees the run with no signals and no composer', async ({ admin, available, told }) => {
    adminFlag.isAdmin = admin
    routes({ [`GET ${BASE}`]: () => engineeringOverview({}, available) })
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    // Only an admin is told why: the deployment does not connect the monitor to the run yet.
    expect(screen.queryByText(/Signals and answers can't be sent from this deployment yet/) !== null).toBe(told)
    expect([screen.queryByRole('group', { name: 'The whole run' }), screen.queryByRole('group', { name: 'Agent fixer-1' })])
      .toStrictEqual([null, null])
    await userEvent.click(screen.getByRole('tab', { name: /Conversation/ }))
    expect(screen.queryByLabelText('Your message')).toBeNull()
    await expectNoBoardControls()
  })

  it('reads an overview that does not say whether the actions are available as unavailable', () => {
    expect(parseOverview({ ...engineeringOverview(), actions_available: undefined }).actions_available).toBe(false)
    expect(parseOverview(engineeringOverview()).actions_available).toBe(true)
  })

  it('an ended run takes no more actions', async () => {
    routes({ [`GET ${BASE}`]: () => engineeringOverview({ ended_at: '2026-11-12T09:30:00Z', status: 'completed' }) })
    renderRun()
    await screen.findByRole('heading', { name: 'Fix the paging bugs' })
    expect(screen.queryByRole('group', { name: 'The whole run' })).toBeNull()
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
