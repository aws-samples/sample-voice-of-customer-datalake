/**
 * @fileoverview A run that needs a person, on the Runs tab: one sentence per
 * reason, the persona verdicts, the admin's decision form from `run.actions`
 * (fix picked objections, accept, something else, close after a confirmation), the
 * read-only card for everyone else, and the decision line after a decision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { wfEdge, wfNode, workflowView } from '@test/workflowFixtures'
import { defined } from '@test/defined'
import { normalizeAgent } from '../../api/agentsApi'
import type { Agent } from '../../api/agentsApi'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunsTab } = await import('./RunsTab')

const AGENT: Agent = defined(normalizeAgent({ agent_id: 'ag_1', name: 'Scout', workflow_id: 'wf_1' }) ?? undefined, 'fixture agent')

const LOOP_EXHAUSTED = {
  reason: 'loop_exhausted', node_id: 'review', node_title: 'PR/FAQ review', loop_index: 0, max_rounds: 3,
  verdicts: [
    { name: 'Budget-minded Traveller', score: 2, blocking: true, objections: ['Fees are hidden.', 'Refunds are slow.', 'No phone line.'] },
    { name: 'Frequent Flyer', score: 4, blocking: false, objections: [] },
  ],
}

const run = (extra: Record<string, unknown> = {}) => ({
  run_id: 'run_1', agent_id: 'ag_1', status: 'needs_human', trigger: 'manual', started_at: '2026-10-04T09:00:00Z',
  finished_at: null, project_id: 'p_9', current_node_id: 'review', model_calls: 40, error: 'The personas did not agree',
  workflow_id: 'wf_1', workflow_revision: 1, needs_human: LOOP_EXHAUSTED, decision: null,
  actions: ['accept', 'another_round', 'stop'], ...extra,
})

const WORKFLOW = workflowView(1, {
  schema: 'voc-workflow/1', name: 'Flow',
  nodes: [wfNode('start', 'start', 'Start'), wfNode('end', 'end', 'Done', 140, { status: 'completed' })],
  edges: [wfEdge('e1', 'start', 'end')],
  loops: [],
})

function routes(current: Record<string, unknown>, extra: Record<string, Handler> = {}) {
  route({
    'GET /agents/ag_1/runs': () => ({ items: [current] }),
    'GET /agents/ag_1/runs/run_1': () => current,
    'GET /agents/ag_1/runs/run_1/events?after=0': () => ({ items: [] }),
    'GET /workflows/wf_1': () => WORKFLOW,
    ...extra,
  })
}

const renderTab = (isAdmin = true) =>
  renderWithQueryClient(<TestRouter><RunsTab agent={AGENT} isAdmin={isAdmin} /></TestRouter>)
const findCard = () => screen.findByRole('region', { name: 'This run needs your decision' })

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
})

describe('RunDecisionCard — why the run stopped', () => {
  it.each([
    [LOOP_EXHAUSTED, 'The personas did not agree on the PR/FAQ review after 3 rounds.'],
    [{ reason: 'no_fail_path', node_title: 'Final review' }, 'Final review did not pass and the workflow has no path for that.'],
    [{ reason: 'end_node', node_title: 'Needs a human' }, 'The workflow sends this run to a person at Needs a human.'],
    [{ reason: 'budget', node_title: '' }, 'The run used its model-call budget.'],
    [{ reason: 'verification', node_title: '' }, "A step's result could not be verified."],
    [{ reason: 'something_new' }, 'The run stopped for a person to decide.'],
  ])('explains %o in one sentence', async (needsHuman, sentence) => {
    routes(run({ needs_human: needsHuman }))
    renderTab()
    expect(within(await findCard()).getByText(sentence)).toBeInTheDocument()
  })

  it('replaces the red error alert and links the project', async () => {
    routes(run())
    renderTab()
    const card = await findCard()
    expect(screen.queryByText('The personas did not agree')).not.toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Open project' })).toHaveAttribute('href', '/projects/p_9')
  })

  it('shows the verdicts on demand, with scores, Blocking and at most five objections', async () => {
    const six = { ...LOOP_EXHAUSTED.verdicts[0], objections: ['Fees are hidden.', 'Refunds are slow.', 'No phone line.', 'A fourth one.', 'A fifth one.', 'A sixth one.'] }
    routes(run({ needs_human: { ...LOOP_EXHAUSTED, verdicts: [six, LOOP_EXHAUSTED.verdicts[1]] } }))
    renderTab(false)
    const card = await findCard()
    await userEvent.click(within(card).getByRole('button', { name: '2 persona verdicts' }))
    expect(within(card).getByText('2/5')).toBeInTheDocument()
    expect(within(card).getAllByText('Blocking')).toHaveLength(1)
    expect(within(card).getByText('A fifth one.')).toBeInTheDocument()
    expect(within(card).queryByText('A sixth one.')).not.toBeInTheDocument()
  })
})

describe('RunDecisionCard — the decision form', () => {
  const SUBMIT = { name: 'Make the decision' }
  const pick = async (card: HTMLElement, label: RegExp | string) => userEvent.click(within(card).getByRole('radio', { name: label }))
  const decided = (extra: Record<string, unknown> = {}) => vi.fn((_body: unknown) => ({ run: run({ status: 'queued', actions: [], ...extra }) }))

  it('offers every allowed choice and waits for one before deciding', async () => {
    routes(run())
    renderTab()
    const card = await findCard()
    const labels = ['Revise once more, fixing the objections I pick', 'Accept it as it is and continue',
      'Something else: tell the agent what to do', 'Close the run']
    // Each radio is named by its label followed by its help line; in this order.
    const names = within(card).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent ?? '')
    expect(names.map((name) => labels.find((label) => name.startsWith(label)))).toStrictEqual(labels)
    expect(within(card).getByRole('button', SUBMIT)).toBeDisabled()
  })

  it('sends the ticked objections and the instructions as the note for one more round', async () => {
    const decide = decided()
    routes(run(), { 'POST /agents/ag_1/runs/run_1/decision': decide })
    renderTab()
    const card = await findCard()
    await pick(card, /Revise once more/)
    // A blocking persona's objections start ticked; untick one.
    expect(within(card).getByRole('checkbox', { name: /Fees are hidden\./ })).toBeChecked()
    await userEvent.click(within(card).getByRole('checkbox', { name: /Refunds are slow\./ }))
    await userEvent.type(within(card).getByLabelText('Your own instructions (optional)'), 'Show the fees up front.')
    await userEvent.click(within(card).getByRole('button', SUBMIT))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({
      decision: 'another_round',
      note: 'Fix these objections:\n- Budget-minded Traveller: Fees are hidden.\n- Budget-minded Traveller: No phone line.\n\nShow the fees up front.',
    }))
  })

  it('needs an objection or an instruction before fixing', async () => {
    routes(run())
    renderTab()
    const card = await findCard()
    await pick(card, /Revise once more/)
    for (const box of within(card).getAllByRole('checkbox', { checked: true })) await userEvent.click(box)
    expect(within(card).getByRole('button', SUBMIT)).toBeDisabled()
    expect(within(card).getByText('Pick at least one objection or write an instruction.')).toBeInTheDocument()
  })

  it('accepts and continues', async () => {
    const decide = decided()
    routes(run(), { 'POST /agents/ag_1/runs/run_1/decision': decide })
    renderTab()
    const card = await findCard()
    await pick(card, /Accept it as it is/)
    expect(within(card).getByText(/carries on after “PR\/FAQ review” as if the personas had agreed/)).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', SUBMIT))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ decision: 'accept' }))
  })

  it('sends "something else" as one more round with only the instructions', async () => {
    const decide = decided()
    routes(run(), { 'POST /agents/ag_1/runs/run_1/decision': decide })
    renderTab()
    const card = await findCard()
    await pick(card, /Something else/)
    expect(within(card).getByRole('button', SUBMIT)).toBeDisabled()
    await userEvent.type(within(card).getByLabelText('Your instructions'), 'Drop the English claim.')
    await userEvent.click(within(card).getByRole('button', SUBMIT))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ decision: 'another_round', note: 'Drop the English claim.' }))
  })

  it('closes the run only after the confirmation', async () => {
    const decide = decided({ status: 'completed' })
    routes(run(), { 'POST /agents/ag_1/runs/run_1/decision': decide })
    renderTab()
    const card = await findCard()
    await pick(card, /Close the run/)
    await userEvent.click(within(card).getByRole('button', SUBMIT))
    const dialog = await screen.findByRole('dialog')
    expect(decide).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close the run' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ decision: 'stop' }))
  })

  it('without objections to pick, drops "fix" and keeps "something else" for another round', async () => {
    const quiet = { ...LOOP_EXHAUSTED, verdicts: LOOP_EXHAUSTED.verdicts.map((v) => ({ ...v, objections: [] })) }
    routes(run({ needs_human: quiet }))
    renderTab()
    const card = await findCard()
    expect(within(card).queryByRole('radio', { name: /Revise once more/ })).not.toBeInTheDocument()
    expect(within(card).getByRole('radio', { name: /Something else/ })).toBeInTheDocument()
    expect(within(card).getAllByRole('radio')).toHaveLength(3)
  })

  it('offers only the choices the server allows, shows the verdicts then, and explains a 409', async () => {
    routes(run({ actions: ['accept', 'stop'] }), { 'POST /agents/ag_1/runs/run_1/decision': () => { throw new Error('API Error: 409') } })
    renderTab()
    const card = await findCard()
    expect(within(card).getAllByRole('radio')).toHaveLength(2)
    expect(within(card).getByRole('button', { name: '2 persona verdicts' })).toBeInTheDocument()
    await pick(card, /Accept it as it is/)
    await userEvent.click(within(card).getByRole('button', SUBMIT))
    expect(await within(card).findByRole('alert')).toHaveTextContent('This run was already decided or is no longer waiting for a decision.')
  })

  it('shows the decision and the resumed run after deciding', async () => {
    const after = run({
      status: 'running', actions: [], error: null,
      decision: { decision: 'another_round', note: 'Fees first.', by_username: 'admin-demo', at: '2026-10-04T10:00:00Z' },
    })
    routes(run(), { 'POST /agents/ag_1/runs/run_1/decision': () => ({ run: after }) })
    renderTab()
    const card = await findCard()
    await pick(card, /Accept it as it is/)
    await userEvent.click(within(card).getByRole('button', SUBMIT))
    expect(await screen.findByText(/admin-demo chose one more round at/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'This run needs your decision' })).not.toBeInTheDocument()
  })
})

describe('RunDecisionCard — everyone else', () => {
  it('shows the card without buttons to a non-admin', async () => {
    routes(run())
    renderTab(false)
    const card = await findCard()
    expect(within(card).getByText('An administrator can decide.')).toBeInTheDocument()
    expect(within(card).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Make the decision' })).not.toBeInTheDocument()
  })
})
