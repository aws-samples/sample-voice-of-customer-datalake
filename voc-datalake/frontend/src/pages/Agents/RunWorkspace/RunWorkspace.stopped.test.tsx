/**
 * @fileoverview The run workspace of a run that stopped (7.51.04), against the shared fixture's run at a person whose
 * orchestrator failed at its checkout (the owner's first run on b-): the banner (what happened, who, at which step,
 * why in the supervisor's words, the last exit behind "Show details", the cost, what to do next and the way to the
 * run's controls), the canvas's "Stopped here: Failed" with no spinner, the orchestrator as the run itself, the
 * timeline's orchestrator row and its step with no agent and no chevron, the supervisor's lines in plain words (a run
 * of the same line once, the raw text behind "Details"), and no banner for a non-admin or a run under way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag, resetFetchApi, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { FAILED_ORCHESTRATOR, FAILED_PATH, RUN_PATH, calledEndpoints, renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
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
