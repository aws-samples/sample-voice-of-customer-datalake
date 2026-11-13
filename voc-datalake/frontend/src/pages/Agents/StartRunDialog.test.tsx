/**
 * @fileoverview "Start a run"'s dialog: its form checks each field as the server does before anything is sent (the
 * first wrong field focused, each message tied to its field), sends the commit in lower case and the goal on one
 * line, shows the flow's budget, and opens the run monitor on the new run; a refusal is said in the server's words
 * and the dialog stays open; Cancel and Escape close it, having sent nothing. Where it is offered is the flow page's
 * (WorkflowPage.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'
import type { WorkflowSummary } from '../../api/workflowsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { StartRunDialog } = await import('./StartRunDialog')

const RUN_ID = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const FLOW: WorkflowSummary = {
  workflow_id: 'wf_1', slug: 'bug-hunt', name: 'Bug hunt', description: '', revision: 1, derived_from: null,
  builtin: false, updated_at: null, updated_by_username: null, status: 'active', kind: 'engineering',
  monthly_budget_usd: 49.99,
}

function renderDialog(start?: Handler, workflow: WorkflowSummary = FLOW) {
  routeFetchApi(start === undefined ? {} : { 'POST /agents/engineering/runs': start })
  const onClose = vi.fn()
  const router = createMemoryRouter([
    { path: '/agents/workflows/wf_1', element: <StartRunDialog workflow={workflow} onClose={onClose} /> },
    { path: '/agents/engineering/:runId', element: <p>Run monitor</p> },
    { path: '/agents', element: <p>Agents</p> },
  ], { initialEntries: ['/agents/workflows/wf_1'] })
  renderWithQueryClient(<RouterProvider router={router} />)
  return { router, onClose, dialog: screen.getByRole('dialog', { name: 'Start a run of Bug hunt' }) }
}

const starts = () => fetchApi.mock.calls.filter(([endpoint]) => endpoint === '/agents/engineering/runs')
const submit = (dialog: HTMLElement) => userEvent.click(within(dialog).getByRole('button', { name: 'Start the run' }))

async function fill(dialog: HTMLElement, fields: { connection?: string; commit?: string; goal?: string }) {
  const { connection = 'conn-storefront', commit = COMMIT, goal = 'Fix the paging bugs' } = fields
  if (connection !== '') await userEvent.type(within(dialog).getByLabelText('Repository connection'), connection)
  if (commit !== '') await userEvent.type(within(dialog).getByLabelText('Commit'), commit)
  if (goal !== '') await userEvent.type(within(dialog).getByLabelText('Goal'), goal)
}

/** A field's state as a screen reader has it: invalid or not, and what describes it. */
function said(dialog: HTMLElement, label: string): [string | null, string | null | undefined] {
  const field = within(dialog).getByLabelText(label)
  return [field.getAttribute('aria-invalid'), document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent]
}

beforeEach(() => { resetFetchApi() })

describe('the Start a run dialog', () => {
  // (the server answers 202 once the run is written, its coordinator's launch under way: client.test.ts reads a 202's
  // body like a 200's)
  it('starts the flow with the checked fields and opens the run monitor on the new run', async () => {
    const start = vi.fn((_body: unknown) => ({ run: { run_id: RUN_ID, status: 'active' } }))
    const { router, dialog } = renderDialog(start)
    expect(within(dialog).getByText('Its monthly budget is the flow’s: $49.99.')).toBeInTheDocument()
    await fill(dialog, { commit: COMMIT.toUpperCase(), goal: '  Fix the   paging bugs ' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Language'), 'JavaScript and TypeScript')
    await submit(dialog)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/engineering/${RUN_ID}`))
    expect(start.mock.calls).toStrictEqual([[{
      workflow_id: 'wf_1', connection: 'conn-storefront', commit: COMMIT, language: 'node', goal: 'Fix the paging bugs',
    }]])
  })

  it('says what is wrong with each field before anything is sent, and focuses the first', async () => {
    const { dialog } = renderDialog()
    await fill(dialog, { connection: 'conn/1', commit: COMMIT.slice(1), goal: '' })
    await submit(dialog)
    expect(within(dialog).getByLabelText('Repository connection')).toHaveFocus()
    expect([said(dialog, 'Repository connection'), said(dialog, 'Commit'), said(dialog, 'Goal')]).toStrictEqual([
      ['true', 'Enter the connection’s id: 1 to 63 letters, digits or hyphens.'],
      ['true', 'Enter the full commit id: 40 characters, 0 to 9 and a to f.'],
      ['true', 'Say what the run is for.'],
    ])
    expect(starts()).toStrictEqual([])
    // A field's message goes once it is changed.
    await userEvent.type(within(dialog).getByLabelText('Commit'), '7')
    expect(said(dialog, 'Commit')).toStrictEqual(['false', 'The full commit id the run starts from: 40 hexadecimal characters.'])
  })

  it('refuses a goal over 500 characters', async () => {
    const { dialog } = renderDialog()
    await fill(dialog, { goal: '' })
    within(dialog).getByLabelText('Goal').focus()
    await userEvent.paste('x'.repeat(501))
    await submit(dialog)
    expect(said(dialog, 'Goal')).toStrictEqual(['true', 'Keep the goal to 500 characters or fewer.'])
    expect(starts()).toStrictEqual([])
  })

  it('says the server\'s refusal in its own words and stays open', async () => {
    const reason = 'no rust image in this deployment: start the run in one of [\'python\']'
    const { dialog, onClose } = renderDialog(() => { throw new ApiError(409, reason) })
    await fill(dialog, {})
    await userEvent.selectOptions(within(dialog).getByLabelText('Language'), 'Rust')
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers the run a 503 names, keeps Start off, and opens its monitor', async () => {
    const reason = `run ${RUN_ID} may have been started: open the run monitor before you start another`
    const { router, dialog } = renderDialog(() => { throw new ApiError(503, reason) })
    await fill(dialog, {})
    await submit(dialog)
    const alert = await within(dialog).findByRole('alert')
    expect([alert.textContent.includes(reason), within(dialog).getByRole('button', { name: 'Start the run' })])
      .toStrictEqual([true, expect.objectContaining({ disabled: true })])
    await submit(dialog)   // (a second press starts nothing: there may already be a run)
    expect(starts()).toHaveLength(1)
    await userEvent.click(within(alert).getByRole('link', { name: 'Open the run' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/engineering/${RUN_ID}`))
  })

  it.each([
    ['a 504', () => { throw new ApiError(504, 'Endpoint request timed out') }],
    ['a network failure', () => { throw new TypeError('Failed to fetch') }],
    ['an answer that is not one', () => '<html>gateway</html>'],
  ])('after %s says the run may have been started, keeps Start off and offers the flow\'s runs', async (_what, answer) => {
    const { router, dialog } = renderDialog(answer)
    await fill(dialog, {})
    await submit(dialog)
    const alert = await within(dialog).findByRole('alert')
    expect([alert.textContent.includes('The run may have been started: check the runs list before you start another.'),
      within(dialog).getByRole('button', { name: 'Start the run' })])
      .toStrictEqual([true, expect.objectContaining({ disabled: true })])
    await userEvent.click(within(alert).getByRole('link', { name: 'See the flow’s runs' }))
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`)
      .toBe('/agents?tab=spend&by=run&workflow=wf_1'))
    expect(starts()).toHaveLength(1)
  })

  it('says a flow has no budget, and closes on Cancel or Escape having sent nothing', async () => {
    const { dialog, onClose } = renderDialog(undefined, { ...FLOW, monthly_budget_usd: null })
    expect(within(dialog).getByText('The flow has no monthly budget.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Escape}')
    expect([onClose.mock.calls.length, starts().length]).toStrictEqual([2, 0])
  })
})
