/**
 * @fileoverview The run workspace rendered against the shared fixture (item B's API answers): the header's budget
 * used against the cap, the canvas (stages, lanes, the gate's pass, "you are here"; inert: a click opens a session),
 * the timeline, an agent's Slack-like thread (its words, its thinking folded, a tool call on one line opened into its
 * result, the harness's messages folded, steering inline), the sessions as tabs or a grid kept in this tab, the
 * inspector's tabs (Changes collapsed per file and read on open with its links on GitHub, the Gate of an agent that
 * ran none, Assertions, Cost, Memory) and who may act.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag, resetFetchApi, sentFetchApiBody, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { AGENT, RUN_PATH, calledEndpoints, endpointOf, renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
import fixture from '@test/engineeringRunWorkspace.json'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
// (the original kept beside the doubles: the shared safe-Markdown policy's links reach the assistant's store)
vi.mock('../../../store/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store/authStore')>()),
  ...(await import('@test/fetchApiRoutes')).authStoreModule(),
}))

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  workspaceRoutes()
})

afterEach(() => { window.sessionStorage.clear() })

const AT_FIXER = `${RUN_PATH}/a/${AGENT}`
const inspectorOf = async () => within(await screen.findByRole('region', { name: 'Inspector' }))
const threadOf = async () => within(await screen.findByRole('list', { name: `The thread of ${AGENT}` }))

describe('the header and the canvas', () => {
  it('shows the budget the run used against its cap', async () => {
    renderWorkspace(RUN_PATH)
    expect(await screen.findByText('Cost so far: $1.61 of its $50.00 cap')).toBeInTheDocument()
    expect(screen.getByText('3% of the cap')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Budget used' })).toHaveAttribute('aria-valuenow', '3')
  })

  it('draws each step\'s agents as lanes, the gate passed and the step the run is on', async () => {
    renderWorkspace(RUN_PATH)
    const lanes = await screen.findAllByTestId('run-lane')
    expect(lanes.map((lane) => [lane.textContent, lane.dataset.laneState])).toStrictEqual([
      ['fixer-3fixer · attempt 2', 'running'], ['gate-runner-4gate-runner', 'ran_ok'], ['final-go-5final-go', 'ran_ok'],
    ])
    expect(within(screen.getByTestId('step-gate')).getByText('GO')).toBeInTheDocument()
    expect(within(screen.getByTestId('step-board')).getByText('You are here')).toBeInTheDocument()
  })

  it('opens an agent\'s session from its lane, and acts on nothing', async () => {
    const router = renderWorkspace(RUN_PATH)
    const [fixer] = await screen.findAllByTestId('run-lane')
    // A click alone: d3-zoom's own mousedown on the pane needs a window jsdom's synthetic events lack.
    fireEvent.click(fixer ?? document.body)
    await waitFor(() => expect(router.state.location.pathname).toBe(AT_FIXER))
    expect(calledEndpoints('POST')).toStrictEqual([])
  })

  it('switches to the timeline: steps, their agents and attempts, and opens a session from it', async () => {
    const router = renderWorkspace(RUN_PATH)
    await userEvent.click(await screen.findByRole('button', { name: 'Timeline' }))
    const timeline = within(screen.getByRole('list', { name: 'What has happened, step by step' }))
    expect(timeline.getByText('attempt 2 (now) · attempt 1')).toBeInTheDocument()
    await userEvent.click(timeline.getByRole('button', { name: /gate-runner-4/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${RUN_PATH}/a/gate-runner-4`))
  })
})

describe('an agent\'s thread', () => {
  it('shows its words, its thinking folded and the harness\'s message to the model folded', async () => {
    renderWorkspace(AT_FIXER)
    const thread = await threadOf()
    expect(await thread.findByText('I will read the paging helper first.')).toBeVisible()
    expect(thread.getByText('The slice end adds one: that is the extra item.')).not.toBeVisible()
    expect(thread.getAllByText('To the model, from harness').length).toBeGreaterThan(0)
  })

  it('reads its next page by cursor: a later item replaces the call by its ref, steering inline', async () => {
    renderWorkspace(AT_FIXER)
    const thread = await threadOf()
    expect(await thread.findByText('Keep the public signature of last_page as it is.', {}, { timeout: 8000 })).toBeInTheDocument()
    expect(thread.getAllByRole('button', { name: /"argv"/ })).toHaveLength(1)
    expect(calledEndpoints()).toContain(`${RUN_PATH}/agents/${AGENT}/thread?${new URLSearchParams({ after: fixture.thread.answer.next, limit: '200' }).toString()}`)
  }, 15_000)

  it('shows a tool call on one line, and opens it into its whole event and result, read then', async () => {
    renderWorkspace(AT_FIXER)
    const thread = await threadOf()
    const call = await thread.findByRole('button', { name: /"argv"/ })
    expect(calledEndpoints()).not.toContain(endpointOf(fixture.thread_item))
    await userEvent.click(call)
    expect(await thread.findByText(/FAILED tests\/test_paging.py::test_the_last_page/)).toBeInTheDocument()
    expect(call).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('the inspector', () => {
  it('lists the changed files collapsed, reads one only when opened, and links the change and the PR on GitHub', async () => {
    renderWorkspace(AT_FIXER)
    const inspector = await inspectorOf()
    const file = await inspector.findByRole('button', { name: /src\/paging\.py/ })
    expect(calledEndpoints()).not.toContain(endpointOf(fixture.change_file))
    await userEvent.click(file)
    expect(await inspector.findByText('return items[start:start + size]')).toBeInTheDocument()
    expect([inspector.getByRole('link', { name: 'Open the change on GitHub' }), inspector.getByRole('link', { name: 'Open the pull request on GitHub' })]
      .map((link) => link.getAttribute('href'))).toStrictEqual([fixture.changes.answer.commit_url, fixture.changes.answer.pr_url])
  })

  it('shows a rename, a binary file and the split view', async () => {
    renderWorkspace(AT_FIXER)
    const inspector = await inspectorOf()
    expect(await inspector.findByText('docs/old-paging.md → docs/paging.md')).toBeInTheDocument()
    await userEvent.click(inspector.getByRole('button', { name: /assets\/logo\.png/ }))
    expect(inspector.getByText('A binary file: not shown.')).toBeInTheDocument()
    expect(inspector.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('says an agent ran no gate and opens the run\'s gate agent, whose checks and verdict it shows', async () => {
    const router = renderWorkspace(AT_FIXER)
    const inspector = await inspectorOf()
    await userEvent.click(await inspector.findByRole('tab', { name: 'Gate' }))
    await userEvent.click(await inspector.findByRole('button', { name: 'See the gate of gate-runner-4' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`${RUN_PATH}/a/gate-runner-4`))
    expect(await inspector.findByText('Verdict: GO')).toBeInTheDocument()
  })

  it('shows the run\'s assertions by step, the agent\'s files, its cost and its memory', async () => {
    renderWorkspace(AT_FIXER)
    const inspector = await inspectorOf()
    await userEvent.click(await inspector.findByRole('tab', { name: 'Assertions' }))
    expect(await inspector.findByText('11 lines changed of 400', { exact: false })).toBeInTheDocument()
    await userEvent.click(inspector.getByRole('tab', { name: 'Files' }))
    expect(await inspector.findByText('paging.py')).toBeInTheDocument()
    await userEvent.click(inspector.getByRole('tab', { name: 'Memory and Learn' }))
    expect(await inspector.findByText('A fixer that stalls on paging: read the helper before the tests.')).toBeInTheDocument()
  })
})

describe('the sessions', () => {
  it('opens on the orchestrator\'s session, as a tab, and keeps a grid of two in this tab', async () => {
    renderWorkspace(RUN_PATH)
    const sessions = within(await screen.findByRole('region', { name: 'The sessions open' }))
    expect(sessions.getByRole('tab', { name: 'Orchestrator' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(sessions.getByRole('button', { name: 'A grid of 2' }))
    expect(sessions.getByRole('group', { name: 'The sessions side by side' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('voc-run-workspace')).toContain('"mode":"grid"')
  })

  it('keeps only tabs in the tablist: the session\'s close button sits beside it, and one menu opens another agent', async () => {
    renderWorkspace(RUN_PATH)
    const tablist = await screen.findByRole('tablist', { name: 'Open sessions' })
    expect(within(tablist).queryAllByRole('button')).toStrictEqual([])
    expect(screen.getByRole('button', { name: 'Close Orchestrator' })).toHaveClass('icon-btn')
    expect(screen.getByRole('combobox', { name: 'Open another agent' })).toBeInTheDocument()
  })

  it('shows a non-admin the run read-only: no composer, no controls', async () => {
    adminFlag.isAdmin = false
    renderWorkspace(AT_FIXER)
    const thread = await threadOf()
    await thread.findByText('I will read the paging helper first.')
    expect(screen.queryByRole('textbox', { name: 'Steer the orchestrator' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })
})

describe('an agent\'s controls', () => {
  it('restarts the agent from its checkpoint through a signal, at the attempt it is on, after asking', async () => {
    workspaceRoutes({ [`POST ${fixture.signal_restart.path}`]: () => fixture.signal_restart.answer })
    renderWorkspace(AT_FIXER)
    await userEvent.click(await screen.findByRole('button', { name: 'More for fixer-3' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Restart…' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(sentFetchApiBody(fixture.signal_restart.path, 'POST')).toStrictEqual(fixture.signal_restart.body))
  })
})
