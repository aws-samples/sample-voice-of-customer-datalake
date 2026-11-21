/**
 * @fileoverview The run workspace against the shared fixture (one harness, one set of doubles), in four parts, each
 * described above its block: a run under way (the header, the canvas, the threads, the inspector, the sessions, an
 * agent's controls); a run that stopped (7.51.04: the banner, "Stopped here", the supervisor's lines); the run's
 * control bar (7.51.00: Stop, Stop now, Pause and Resume); and Restart run on an ended run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../lib/errors'
import { SIGNED_IN_SUB, adminFlag, resetFetchApi, sentFetchApiBody, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { withMemoryLocalStorage } from '@test/memoryLocalStorage'
import { AGENT, FAILED_ORCHESTRATOR, FAILED_PATH, RUN_PATH, calledEndpoints, endpointOf, renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
import fixture from '@test/engineeringRunWorkspace.json'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
// (the original kept beside the doubles: the shared safe-Markdown policy's links reach the assistant's store)
vi.mock('../../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))

stubResizeObserverForSuite()

/**
 * The run workspace rendered against the shared fixture (item B's API answers): the header's budget
 * used against the cap, the canvas (stages, lanes, the gate's pass, "you are here"; inert: a click opens a session),
 * the timeline, an agent's Slack-like thread (its words, its thinking folded, a tool call on one line opened into its
 * result, the harness's messages folded, steering inline), the sessions as tabs or a grid kept in this tab, the
 * inspector's tabs (Changes collapsed per file and read on open with its links on GitHub, the Gate of an agent that
 * ran none, Assertions, Cost, Memory) and who may act.
 */
describe('a run under way', () => {
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

    it('shows once what the start said beside the run (7.63.00), until dismissed', async () => {
      const expiring = "The connection's fine-grained token expires in 2 days: its owner replaces it under Agents → Connections before then, or the run's push is refused."
      renderWorkspace(RUN_PATH, { startWarnings: [expiring] })
      const banner = screen.getAllByRole('status').find((each) => each.textContent.includes(expiring))
      expect(banner).toHaveTextContent(`The run started with a warning${expiring}Dismiss`)
      await userEvent.click(within(banner ?? document.body).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText(expiring)).not.toBeInTheDocument()
    })

    it('shows no start warning on a run opened any other way', async () => {
      renderWorkspace(RUN_PATH, { startWarnings: 'not a list' })
      expect(await screen.findByText('Cost so far: $1.61 of its $50.00 cap')).toBeInTheDocument()
      expect(screen.queryByText('The run started with a warning')).not.toBeInTheDocument()
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
      // (7.54.00: "Thinking…" with its first words beside it; the whole of it inside, folded)
      const thinking = thread.getByText('Thinking…').closest('details')
      expect(thinking).not.toHaveAttribute('open')
      expect(within(thinking ?? document.body).getByText('The slice end adds one: that is the extra item.', { selector: 'p' })).not.toBeVisible()
      expect(thread.getAllByText('To the model, from harness').length).toBeGreaterThan(0)
    })

    it('shows what the agent hands in as its reply, under its name, before the call that carries it (7.54.00)', async () => {
      renderWorkspace(AT_FIXER)
      const thread = await threadOf()
      const reply = await thread.findByText('The last page now holds at most a page.', { selector: 'p' }, { timeout: 8000 })
      const row = reply.closest('li')
      expect(row?.dataset.ref).toMatch(/\.1$/)
      expect(within(row ?? document.body).getByText(AGENT)).toBeInTheDocument()
      expect(row?.nextElementSibling).toHaveTextContent('submit_work')
    }, 15_000)

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

    it('keeps only tabs in the tablist, each with its own close, the panel named by the tab shown (7.54.00)', async () => {
      renderWorkspace(RUN_PATH)
      const tablist = await screen.findByRole('tablist', { name: 'Open sessions' })
      expect(within(tablist).queryAllByRole('button')).toStrictEqual([])
      const tab = within(tablist).getByRole('tab', { name: 'Orchestrator' })
      // (its × is part of the tab, out of the accessibility tree; Delete closes it, as its description says; no select)
      expect([
        within(tab).getByTestId('close-tab-coordinator-1').getAttribute('aria-hidden'), tab.getAttribute('aria-keyshortcuts'),
        screen.getByRole('tabpanel', { name: 'Orchestrator' }).id === tab.getAttribute('aria-controls'),
        screen.queryByRole('combobox', { name: 'Open another agent' }),
      ]).toStrictEqual(['true', 'Delete', true, null])
      expect(tab).toHaveAccessibleDescription('Delete closes this tab.')
    })

    it('opens another agent from "Open…" at the end of the strip, and moves between the tabs by arrow (7.54.00)', async () => {
      const router = renderWorkspace(RUN_PATH)
      await userEvent.click(await screen.findByRole('button', { name: 'Open another agent' }))
      await userEvent.click(screen.getByRole('menuitem', { name: AGENT }))
      await waitFor(() => expect(router.state.location.pathname).toBe(AT_FIXER))
      const tablist = within(screen.getByRole('tablist', { name: 'Open sessions' }))
      const fixer = tablist.getByRole('tab', { name: new RegExp(AGENT) })
      expect([fixer.getAttribute('aria-selected'), fixer.tabIndex]).toStrictEqual(['true', 0])
      fixer.focus()
      await userEvent.keyboard('{ArrowLeft}')
      expect(tablist.getByRole('tab', { name: 'Orchestrator' })).toHaveFocus()
      await userEvent.keyboard('{End}')
      // (manual activation: moving opens nothing; Enter does)
      expect([document.activeElement === fixer, router.state.location.pathname]).toStrictEqual([true, AT_FIXER])
    })

    it('closes a tab from its own × or by Delete, the focus on the tab now in its place (7.54.00)', async () => {
      const router = renderWorkspace(RUN_PATH)
      const tablist = within(await screen.findByRole('tablist', { name: 'Open sessions' }))
      const openFixer = async () => {
        await userEvent.click(screen.getByRole('button', { name: 'Open another agent' }))
        await userEvent.click(screen.getByRole('menuitem', { name: AGENT }))
        await waitFor(() => expect(tablist.getAllByRole('tab')).toHaveLength(2))
      }
      await openFixer()
      await userEvent.click(tablist.getByTestId(`close-tab-${AGENT}`))
      await waitFor(() => expect(tablist.getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual(['Orchestrator']))
      await waitFor(() => expect(router.state.location.pathname).toBe(RUN_PATH))
      await openFixer()
      const fixer = tablist.getByRole('tab', { name: new RegExp(AGENT) })
      fixer.focus()
      await userEvent.keyboard('{Delete}')
      await waitFor(() => expect([tablist.getAllByRole('tab').length, document.activeElement === tablist.queryByRole('tab', { name: 'Orchestrator' })])
        .toStrictEqual([1, true]))
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

  describe('"Show thinking" (7.54.00)', () => {
    const saved = withMemoryLocalStorage()
    const switchOf = () => screen.getByRole('switch', { name: 'Show thinking' })

    it('is on for an admin with no choice yet, and off hides the thinking, kept for this person', async () => {
      renderWorkspace(AT_FIXER)
      const thread = await threadOf()
      await thread.findByText('Thinking…')
      expect(switchOf()).toBeChecked()
      await userEvent.click(switchOf())
      expect(thread.queryByText('Thinking…')).not.toBeInTheDocument()
      expect(thread.getByText('I will read the paging helper first.')).toBeVisible()
      expect(saved.get(`voc-thread-thinking:${SIGNED_IN_SUB}`)).toBe('off')
    })

    it('is off for someone else with no choice yet, and their stored choice wins', async () => {
      adminFlag.isAdmin = false
      renderWorkspace(AT_FIXER)
      const thread = await threadOf()
      await thread.findByText('I will read the paging helper first.')
      expect(switchOf()).not.toBeChecked()
      expect(thread.queryByText('Thinking…')).not.toBeInTheDocument()
      cleanup()
      saved.set(`voc-thread-thinking:${SIGNED_IN_SUB}`, 'on')
      renderWorkspace(AT_FIXER)
      expect(await (await threadOf()).findByText('Thinking…')).toBeInTheDocument()
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
})

/**
 * The run workspace of a run that stopped (7.51.04), against the shared fixture's run at a person whose
 * orchestrator failed at its checkout (the owner's first run on b-): the banner (what happened, who, at which step,
 * why in the supervisor's words, the last exit behind "Show details", the cost, what to do next and the way to the
 * run's controls), the canvas's "Stopped here: Failed" with no spinner, the orchestrator as the run itself, the
 * timeline's orchestrator row and its step with no agent and no chevron, the supervisor's lines in plain words (a run
 * of the same line once, the raw text behind "Details"), and no banner for a non-admin or a run under way.
 */
describe('a run that stopped (7.51.04)', () => {
  beforeEach(() => {
    resetFetchApi()
    adminFlag.isAdmin = true
    workspaceRoutes()
  })

  const HEADLINE = 'The repository checkout failed: the run is waiting for a person.'
  const FLOW = 'The run’s flow, with the steps its agents are on'
  const bannerOf = async () => within(await screen.findByRole('region', { name: HEADLINE }))
  const flowOf = async () => within(await screen.findByRole('region', { name: FLOW }))
  /** The spinners in the flow pane. */
  const flowSpinners = () => screen.getByRole('region', { name: FLOW }).querySelectorAll('.animate-spin')

  describe('the banner of a run at a person whose orchestrator failed', () => {
    it('says what happened, who, at which step, why, the cost so far and what to do next', async () => {
      renderWorkspace(FAILED_PATH)
      const banner = await bannerOf()
      expect(await banner.findByText('Step: Understand and classify')).toBeInTheDocument()
      expect([
        banner.queryByText('Agent: coordinator-1 (the orchestrator)') !== null,
        banner.queryByText('Cost so far: $0.03') !== null,
        banner.queryByText(/^Once the cause is fixed, Resume the run from its controls/) !== null,
        screen.getByRole('region', { name: HEADLINE }).dataset.tone,
      ]).toStrictEqual([true, true, true, 'danger'])
      expect(banner.getByText('Why:').parentElement).toHaveTextContent(`Why: ${fixture.failed_overview.answer.run.waiting_detail}`)
    })

    it('keeps the last exit behind Show details: its code, how long it ran and the end of its error output', async () => {
      renderWorkspace(FAILED_PATH)
      const banner = await bannerOf()
      const stderr = banner.getByText(/^fatal: detected dubious ownership in repository at/)
      expect(stderr).not.toBeVisible()
      await userEvent.click(banner.getByText('Show details'))
      expect(stderr).toBeVisible()
      expect(banner.getByText('Exit code').nextElementSibling).toHaveTextContent('128')
      expect(banner.getByText('Ran for').nextElementSibling).toHaveTextContent('2 s')
    })

    it('moves to the run\'s controls and opens the failed agent\'s session; it acts on nothing itself', async () => {
      const router = renderWorkspace(FAILED_PATH)
      const banner = await bannerOf()
      await userEvent.click(banner.getByRole('button', { name: 'Go to the run\'s controls' }))
      expect(document.activeElement).toContainElement(screen.getByRole('heading', { name: 'Run controls' }))
      await userEvent.click(banner.getByRole('button', { name: 'Open coordinator-1\'s session' }))
      await waitFor(() => expect(router.state.location.pathname).toBe(FAILED_PATH))
      const sessions = within(screen.getByRole('region', { name: 'The sessions open' }))
      expect(sessions.getByRole('tab', { name: 'Orchestrator' })).toHaveAttribute('aria-selected', 'true')
      expect(calledEndpoints('POST')).toStrictEqual([])
    })

    it('is an admin\'s alone, and a run under way has none', async () => {
      adminFlag.isAdmin = false
      renderWorkspace(FAILED_PATH)
      await flowOf()
      expect(screen.queryByRole('region', { name: HEADLINE })).not.toBeInTheDocument()
      adminFlag.isAdmin = true
      renderWorkspace(RUN_PATH)
      expect(await screen.findAllByTestId('run-lane')).not.toHaveLength(0)
      expect(screen.queryByText('Show details')).not.toBeInTheDocument()
    })
  })

  describe('the flow of a run that stopped', () => {
    it('marks where it stopped as failed on the canvas, with the orchestrator as the run itself and no spinner', async () => {
      renderWorkspace(FAILED_PATH)
      const flow = await flowOf()
      const step = await flow.findByTestId('step-classify')
      expect([
        within(step).queryByText('Stopped here: Failed') !== null,
        within(step).queryByLabelText('Failed') !== null,
        flow.queryByRole('button', { name: /^Orchestrator\s*coordinator-1\s*Failed/ }) !== null,
        flow.queryByText('You are here'),
        flowSpinners().length,
      ]).toStrictEqual([true, true, true, null, 0])
    })

    it('gives the orchestrator its own row in the timeline, and a step with no agent no chevron', async () => {
      renderWorkspace(FAILED_PATH)
      await userEvent.click(await screen.findByRole('button', { name: 'Timeline' }))
      const timeline = within(screen.getByRole('list', { name: 'What has happened, step by step' }))
      const [first] = timeline.getAllByRole('listitem')
      expect(first).toHaveTextContent(/^Orchestratorcoordinator-1Failedattempt 1 \(now\)$/)
      const classify = timeline.getByText('Understand and classify').closest('li')
      expect([classify?.textContent.includes('Stopped here'), classify?.textContent.includes('No agents')]).toStrictEqual([true, true])
      expect([
        timeline.queryByText('On no step of the flow'),
        within(classify ?? document.body).queryByRole('button'),
        flowSpinners().length,
      ]).toStrictEqual([null, null, 0])
    })
  })

  describe('the orchestrator\'s thread', () => {
    it('says the supervisor\'s lines in plain words, a run of the same line once, the raw text behind Details', async () => {
      renderWorkspace(FAILED_PATH)
      const thread = within(await screen.findByRole('list', { name: `The thread of ${FAILED_ORCHESTRATOR}` }))
      const starting = await thread.findByText('Starting… · $0.00')
      expect(starting.parentElement).toHaveTextContent('said 3 times')
      expect([
        'coordinator-1 stopped unexpectedly and was restarted (attempt 2 of 3)',
        'coordinator-1 stopped unexpectedly and was restarted (attempt 3 of 3)',
        'coordinator-1 failed 3 times; the run needs a person',
        /^coordinator-1 could not start: The repository checkout failed/,
        'Failed · $0.03',
      ].map((line) => thread.queryByText(line) !== null)).toStrictEqual([true, true, true, true, true])
      expect(thread.queryByText('1 booting (tokens 0, cost_usd 0.00)', { exact: false })).not.toBeVisible()
      expect(await screen.findByText('This session has ended: it failed.')).toBeInTheDocument()
    })
  })
})

/**
 * The run's control bar against the shared fixture (7.51.00, the UX audit's S8/S9): Stop is the run's
 * Stop (7.50.03, `POST …/stop`, never a signal: a checkpoint, then the end) and reads Stopping… with Stop inert and
 * what each agent did; "Stop now, without saving" is in Stop's menu, asked first, and sent confirmed; Pause and Resume
 * are one toggle by the agents' state; the run's status chip is toned; an agent and the run say Stop alike.
 */
describe('the run control bar (7.51.00)', () => {
  const SIGNALS = `${RUN_PATH}/signals`
  const STOP = `${RUN_PATH}/stop`
  const stopped = { signal: { event_id: 'e', signal: 'resume', agents: { 'fixer-3': 'working' }, applied: { 'fixer-3': true } } }
  const saving = { stop: { status: 'stopping', mode: 'stop', tasks_closed: [], saving: ['fixer-3'] } }

  function withSignals(answer: RouteHandler = () => stopped, overview: unknown = fixture.overview.answer, stop: RouteHandler = () => saving) {
    workspaceRoutes({ [`GET ${RUN_PATH}`]: () => overview, [`POST ${SIGNALS}`]: answer, [`POST ${STOP}`]: stop })
  }

  beforeEach(() => {
    resetFetchApi()
    adminFlag.isAdmin = true
  })

  describe('the run control bar', () => {
    it('shows the run\'s status in its tone, and Stop, Pause and More run controls', async () => {
      withSignals()
      renderWorkspace(RUN_PATH)
      expect(await screen.findByText('Active')).toHaveClass('badge-accent')
      expect([screen.getByRole('button', { name: 'Pause' }), screen.getByRole('button', { name: 'More ways to stop' }),
        screen.getByRole('button', { name: 'More run controls' })]).toHaveLength(3)
    })

    it('stops the run through its Stop (a checkpoint first), then reads Stopping… with Stop inert and what each agent did', async () => {
      const run = { stopping: false }
      const overview = fixture.overview.answer
      workspaceRoutes({
        [`GET ${RUN_PATH}`]: () => (run.stopping ? { ...overview, run: { ...overview.run, stop: { mode: 'stop', requested_at: '2026-11-17T09:30:00Z' } },
          agents: overview.agents.map((agent) => (agent.agent === 'fixer-3' ? { ...agent, status: 'pause_requested' } : agent)) } : overview),
        [`POST ${STOP}`]: () => {
          run.stopping = true
          return saving
        },
      })
      renderWorkspace(RUN_PATH)
      const bar = within(await screen.findByRole('region', { name: 'Run controls' }))
      await userEvent.click(bar.getByRole('button', { name: 'Stop' }))
      await waitFor(() => expect(sentFetchApiBody(STOP, 'POST')).toStrictEqual({}))
      expect(await bar.findByText('Stopping…')).toHaveClass('badge-warn')
      expect(bar.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true')
      // What the Stop said, and each agent's part of it, both announced; Pause is gone while it stops.
      expect([bar.getByText('Stop sent: fixer-3 saving a checkpoint, then the run stops.').getAttribute('role'),
        bar.getByText(/^Stop sent · .*fixer-3 saving a checkpoint…/).getAttribute('role'),
        bar.queryByRole('button', { name: 'Pause' })]).toStrictEqual(['status', 'status', null])
    })

    it('keeps "Stop now, without saving" in Stop\'s menu, asks before it, and sends it confirmed as the run\'s Stop', async () => {
      const signal = vi.fn((_body: unknown) => stopped)
      const stop = vi.fn((_body: unknown) => ({ stop: { status: 'stopped', mode: 'stop_now', tasks_closed: ['task-fix'] } }))
      withSignals(signal, undefined, stop)
      renderWorkspace(RUN_PATH)
      await userEvent.click(await screen.findByRole('button', { name: 'More ways to stop' }))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Stop now, without saving…' }))
      expect(stop).not.toHaveBeenCalled()
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop now, without saving' }))
      await waitFor(() => expect(stop).toHaveBeenCalledWith({ now: true, confirm: true }))
      expect([await screen.findByText('Stopped. 1 open task was closed.'), signal.mock.calls]).toStrictEqual([expect.anything(), []])
    })

    it('offers Resume, not Pause, once every agent at work is paused', async () => {
      const paused = { ...fixture.overview.answer, agents: fixture.overview.answer.agents.map((agent) => ({ ...agent, status: agent.status === 'done' ? 'done' : 'paused' })) }
      withSignals(() => stopped, paused)
      renderWorkspace(RUN_PATH)
      await userEvent.click(await screen.findByRole('button', { name: 'Resume' }))
      await waitFor(() => expect(sentFetchApiBody(SIGNALS, 'POST')).toStrictEqual({ signal: 'resume' }))
      expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    })

    it('says a signal was sent as the start function answers it, the overview showing what came of it (7.51.02)', async () => {
      withSignals(() => ({ signal: { signal: 'pause', target: { kind: 'run', id: fixture.run_id }, attempt: 0, status: 'sent', agents: {}, applied: {} } }))
      renderWorkspace(RUN_PATH)
      const bar = within(await screen.findByRole('region', { name: 'Run controls' }))
      await userEvent.click(bar.getByRole('button', { name: 'Pause' }))
      await waitFor(() => expect(sentFetchApiBody(SIGNALS, 'POST')).toStrictEqual({ signal: 'pause' }))
      expect(await bar.findByText('Sent.')).toHaveAttribute('role', 'status')
    })

    it('shows Pause, Resume and Save by their own flag, Stop by its own, each saying why where it is off', async () => {
      withSignals(undefined, { ...fixture.overview.answer, signals_available: false })
      renderWorkspace(RUN_PATH)
      const bar = within(await screen.findByRole('region', { name: 'Run controls' }))
      expect([bar.queryByRole('button', { name: 'Pause' }), bar.queryByRole('button', { name: 'More run controls' }),
        bar.getByRole('button', { name: 'Stop' }).isConnected,
        bar.getByText("Pause, Resume and Save can't reach this run from this deployment: it names no start function.").isConnected])
        .toStrictEqual([null, null, true, true])
      cleanup()
      withSignals(undefined, { ...fixture.overview.answer, stop_available: false })
      renderWorkspace(RUN_PATH)
      const signalling = within(await screen.findByRole('region', { name: 'Run controls' }))
      expect([signalling.getByRole('button', { name: 'Pause' }).isConnected, signalling.queryByRole('button', { name: 'Stop' }),
        signalling.queryByText(/Pause, Resume and Save can't reach/), signalling.getByText(/Stop can't reach this run/).isConnected])
        .toStrictEqual([true, null, null, true])
    })

    it('uses the run\'s word for an agent\'s Stop, its other moves under ⋯', async () => {
      withSignals()
      renderWorkspace(`${RUN_PATH}/a/${fixture.agent}`)
      const agent = within(await screen.findByRole('group', { name: `Agent ${fixture.agent}` }))
      await userEvent.click(agent.getByRole('button', { name: `More for ${fixture.agent}` }))
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['Save a checkpoint', 'Stop now, without saving…', 'Restart…'])
      expect(agent.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    })
  })
})

/**
 * Restart run on an ended run, against the shared fixture: offered only once the run has ended, it asks
 * how (resume or restart), on which commit and which agents, posts `…/restart` with `confirm: true`, and opens the
 * child run; an answer that could not be read names the child to open (and keeps the dialog from starting another);
 * a refusal says the server's reason. The child's workspace names the run it was resumed from.
 */
describe('Restart run on an ended run', () => {
  const ENDED = `/agents/engineering/${fixture.ended_run_id}`
  const CHILD = `/agents/engineering/${fixture.child_run_id}`
  const ENDED_AGENTS = [{ agent: 'fixer-1', role: 'fixer', task_id: 'task-export', status: 'stopped', attempt: 1 }]

  function endedRoutes(restart: RouteHandler = () => fixture.restart.answer) {
    workspaceRoutes({
      [`GET ${ENDED}`]: () => ({ ...fixture.ended_overview.answer, agents: ENDED_AGENTS }),
      [`GET ${CHILD}`]: () => fixture.child_overview.answer,
      [`POST ${fixture.restart.path}`]: restart,
    })
  }

  async function openDialog() {
    await userEvent.click(await screen.findByRole('button', { name: 'Restart run' }))
    return within(screen.getByRole('dialog', { name: 'Restart this run?' }))
  }

  beforeEach(() => {
    resetFetchApi()
    adminFlag.isAdmin = true
  })

  describe('Restart run', () => {
    it('is offered once the run has ended, never on a run under way', async () => {
      workspaceRoutes()
      renderWorkspace(`/agents/engineering/${fixture.run_id}`)
      expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Restart run' })).not.toBeInTheDocument()
    })

    it('resumes from the agents\' checkpoints on the run\'s own commit by default, and opens the child', async () => {
      endedRoutes()
      const router = renderWorkspace(ENDED)
      const dialog = await openDialog()
      await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
      await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/engineering/${fixture.restart.answer.run.run_id}`))
      expect(sentFetchApiBody(fixture.restart.path, 'POST')).toStrictEqual(fixture.restart.body)
    })

    it('restarts the agents ticked afresh on the repository\'s head', async () => {
      endedRoutes()
      renderWorkspace(ENDED)
      const dialog = await openDialog()
      await userEvent.click(dialog.getByRole('radio', { name: 'Restart: their tasks afresh' }))
      await userEvent.click(dialog.getByRole('radio', { name: /The repository's head now/ }))
      await userEvent.click(dialog.getByRole('checkbox', { name: /fixer-1/ }))
      await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
      await waitFor(() => expect(sentFetchApiBody(fixture.restart.path, 'POST'))
        .toStrictEqual({ mode: 'restart', base: 'head', agents: ['fixer-1'], confirm: true }))
    })

    it('runs the new run on another model for every role when one is chosen, and holds an other id off its shape', async () => {
      endedRoutes()
      renderWorkspace(ENDED)
      const dialog = await openDialog()
      const model = dialog.getByRole('combobox', { name: 'Model for the new run' })
      expect(model).toHaveDisplayValue('The same models as this run')
      await userEvent.selectOptions(model, 'other')
      await userEvent.type(dialog.getByRole('textbox', { name: 'Model ID' }), 'not a model')
      await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
      expect(calledEndpoints('POST')).not.toContain(fixture.restart.path)
      await userEvent.selectOptions(model, 'sonnet')
      await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
      await waitFor(() => expect(sentFetchApiBody(fixture.restart.path, 'POST'))
        .toStrictEqual({ mode: 'resume', base: 'same', model: 'sonnet', confirm: true }))
    })

    it('names the child to open when the answer could not be read, and starts no other', async () => {
      endedRoutes(() => { throw new ApiError(503, 'run C1 may have been started: open it before you restart this run again', undefined, 'C1') })
      renderWorkspace(ENDED)
      const dialog = await openDialog()
      await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
      expect(await dialog.findByRole('link', { name: 'Open the run' })).toHaveAttribute('href', '/agents/engineering/C1')
      expect(dialog.getByRole('button', { name: 'Start the new run' })).toBeDisabled()
    })

    it('shows the server\'s reason for a refusal', async () => {
      endedRoutes(() => { throw new ApiError(409, 'The run is live: restart one of its agents with the restart signal') })
      renderWorkspace(ENDED)
      const dialog = await openDialog()
      await userEvent.click(dialog.getByRole('button', { name: 'Start the new run' }))
      expect(await dialog.findByRole('alert')).toHaveTextContent('The run is live: restart one of its agents with the restart signal')
    })

    it('links a child run to the run it was resumed from, and the parent to its child', async () => {
      endedRoutes()
      renderWorkspace(CHILD)
      expect(await screen.findByText('Resumed from run')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: fixture.ended_run_id })).toHaveAttribute('href', ENDED)
    })
  })
})
