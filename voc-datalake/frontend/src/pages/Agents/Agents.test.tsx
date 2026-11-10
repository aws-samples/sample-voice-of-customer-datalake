/**
 * @fileoverview Autonomous agents list: rows with state and scope, the admin
 * vs user empty states, the admin create flow (POST then navigate to the new
 * agent), no create button for non-admins, the load failure, and an admin's
 * Rename / Delete on each row (Delete archives after a confirmation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
// Partial: the Plans list reaches the assistant store, which reads the real auth store.
vi.mock('../../store/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/authStore')>()),
  ...(await import('@test/fetchApiRoutes')).authStoreModule(),
}))

const { default: Agents } = await import('./Agents')
const { LIST_POLL_MS } = await import('./useAgents')

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  agent_id: id, name, description: '', enabled: false,
  scope: { all: true, categories: [], subcategories: [] },
  stats: { scheduled_runs_today: 1, model_calls_this_month: 42 },
  ...extra,
})

/** The caller's plans (the Plans list), answered empty unless a test routes it. */
const NO_PLANS: Record<string, RouteHandler> = { 'GET /agents/plans?limit=20': () => ({ plans: [] }) }
const route = (routes: Record<string, RouteHandler>) => routeFetchApi({ ...NO_PLANS, ...routes }, { missStatus: 500 })

function renderList(entry = '/agents') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/:id" element={<p>Agent detail page</p>} />
      </Routes>
    </TestRouter>,
  )
}

/** The row link an agent's name sits in. */
function rowOf(name: HTMLElement): HTMLAnchorElement {
  const row = name.closest('a')
  if (row === null) throw new Error('agent name is not inside a row link')
  return row
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

afterEach(() => { vi.useRealTimers() })

describe('Agents list — a live run', () => {
  it('the card follows its run from Queued to Running without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const live = (status: string) => ({ items: [agent('ag_1', 'Scout', { stats: { last_run_status: status } })] })
    route({ 'GET /agents': () => live('queued') })
    renderList()
    expect(await within(rowOf(await screen.findByText('Scout'))).findByText('Queued')).toBeInTheDocument()
    route({ 'GET /agents': () => live('running') })
    await vi.advanceTimersByTimeAsync(LIST_POLL_MS + 100)
    expect(await within(rowOf(screen.getByText('Scout'))).findByText('Running')).toBeInTheDocument()
  })

  it('a finished run stops the polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    route({ 'GET /agents': () => ({ items: [agent('ag_1', 'Scout', { stats: { last_run_status: 'completed' } })] }) })
    renderList()
    await screen.findByText('Scout')
    const calls = fetchApi.mock.calls.filter(([path]) => path === '/agents').length
    await vi.advanceTimersByTimeAsync(LIST_POLL_MS * 2)
    expect(fetchApi.mock.calls.filter(([path]) => path === '/agents')).toHaveLength(calls)
  })
})

describe('Agents list', () => {
  it('renders each agent with its enabled / disabled badge', async () => {
    route({ 'GET /agents': () => ({ items: [agent('ag_1', 'Scout', { enabled: true }), agent('ag_2', 'Sleeper')] }) })
    renderList()
    const scout = rowOf(await screen.findByText('Scout'))
    expect(scout).toHaveAttribute('href', '/agents/ag_1')
    expect(within(scout).getByText('Enabled')).toBeInTheDocument()
    expect(within(rowOf(screen.getByText('Sleeper'))).getByText('Disabled')).toBeInTheDocument()
  })

  it('shows the scope when there is no description, the description otherwise', async () => {
    route({ 'GET /agents': () => ({ items: [
      agent('ag_1', 'Scoped', { scope: { all: false, categories: ['delivery'], subcategories: [{ category: 'app', name: 'login' }] } }),
      agent('ag_2', 'Everything'),
      agent('ag_3', 'Described', { description: 'Watches checkout' }),
    ] }) })
    renderList()
    // Display labels, never the snake_case ids (here humanised: no category config is served).
    expect(await screen.findByText('Watches: Delivery, App / Login')).toBeInTheDocument()
    expect(screen.getByText('All categories')).toBeInTheDocument()
    expect(screen.getByText('Watches checkout')).toBeInTheDocument()
  })

  it('shows the last run status and the spend', async () => {
    route({ 'GET /agents': () => ({ items: [agent('ag_1', 'Scout', { stats: { last_run_status: 'needs_human', scheduled_runs_today: 2, model_calls_this_month: 7 } })] }) })
    renderList()
    expect(await screen.findByText('Needs a human')).toBeInTheDocument()
    expect(screen.getByText('2 scheduled runs today · 7 model calls this month')).toBeInTheDocument()
  })

  it('invites an admin to create the first agent', async () => {
    route({ 'GET /agents': () => ({ items: [] }) })
    renderList()
    expect(await screen.findByText('No autonomous agents yet')).toBeInTheDocument()
    expect(screen.getByText(/Create one to turn new feedback/)).toBeInTheDocument()
  })

  it('tells a user an administrator has not set one up', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /agents': () => ({ items: [] }) })
    renderList()
    expect(await screen.findByText(/An administrator hasn't set up any agent/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument()
  })

  it('shows a load failure as an announced alert with a retry, not the empty state', async () => {
    const agentsRead = vi.fn<RouteHandler>(() => ({ items: [] }))
    agentsRead.mockImplementationOnce(() => { throw new Error('API Error: 500') })
    route({ 'GET /agents': agentsRead, 'GET /workflows': () => ({ items: [] }) })
    renderList()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Agents couldn't be loaded.")
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No autonomous agents yet')).toBeInTheDocument()
    expect(screen.queryByText("Agents couldn't be loaded.")).not.toBeInTheDocument()
  })
})

/** An empty list (plus `routes`), with the admin's New agent dialog opened. */
async function openCreateDialog(routes: Record<string, RouteHandler> = {}) {
  route({ 'GET /agents': () => ({ items: [] }), ...routes })
  renderList()
  await userEvent.click(await screen.findByRole('button', { name: 'New agent' }))
  return screen.findByRole('dialog')
}

describe('Agents — create', () => {
  it('posts the new agent and navigates to it', async () => {
    const create = vi.fn((_body: unknown) => ({ agent: agent('ag_new', 'Fresh') }))
    const dialog = await openCreateDialog({ 'POST /agents': create })
    await userEvent.type(within(dialog).getByLabelText('Name'), '  Fresh  ')
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Turns reviews into prototypes')
    await userEvent.click(within(dialog).getByRole('button', { name: 'New agent' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: 'Fresh', description: 'Turns reviews into prototypes', scope: { all: true, categories: [], subcategories: [] },
    }))
    expect(await screen.findByText('Agent detail page')).toBeInTheDocument()
  })

  it('keeps the dialog open with an error when the create fails', async () => {
    const dialog = await openCreateDialog()
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Fresh')
    await userEvent.click(within(dialog).getByRole('button', { name: 'New agent' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("The agent couldn't be created.")
  })

  it('needs a name before creating', async () => {
    const dialog = await openCreateDialog()
    await userEvent.type(within(dialog).getByLabelText('Name'), '   ')
    expect(within(dialog).getByRole('button', { name: 'New agent' })).toBeDisabled()
  })
})

// ── Workflow library (QA s2: a workflow could not be removed) ──
// Admins see every workflow and archive one through a confirm; the built-in has
// no Archive; an in-use workflow explains the 409; users see no library at all.

const workflowSummary = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  workflow_id: id, slug: id, name, description: '', revision: 2, derived_from: null,
  builtin: false, updated_at: null, updated_by_username: null, ...extra,
})

/** The Workflows tab, where `/agents/workflows` lands. */
const LIBRARY = '/agents?tab=workflows'

function libraryRoutes(archive: () => unknown) {
  const state = { archived: false }
  route({
    'GET /agents': () => ({ items: [] }),
    'GET /workflows': () => ({
      items: [workflowSummary('wf_default', 'Reviews → Prototype', { builtin: true }),
        ...(state.archived ? [] : [workflowSummary('wf_old', 'Old flow')])],
    }),
    'DELETE /workflows/wf_old': () => {
      const answer = archive()
      state.archived = true
      return answer
    },
  })
}

/** Archive "Old flow" through its confirm dialog. */
async function archiveOldFlow() {
  const user = userEvent.setup()
  renderList(LIBRARY)
  await user.click(await screen.findByRole('button', { name: 'Archive Old flow' }))
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }))
}

describe('Agents — workflow library', () => {
  it('archives a workflow after confirming, and it leaves the list', async () => {
    libraryRoutes(() => ({ workflow: workflowSummary('wf_old', 'Old flow', { status: 'archived' }) }))
    await archiveOldFlow()
    await waitFor(() => { expect(screen.queryByText('Old flow')).not.toBeInTheDocument() })
    expect(fetchApi).toHaveBeenCalledWith('/workflows/wf_old', { method: 'DELETE' })
  })

  it('offers no Archive for the built-in template', async () => {
    libraryRoutes(() => ({}))
    renderList(LIBRARY)
    expect(await screen.findByText('Reviews → Prototype')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive Reviews → Prototype' })).not.toBeInTheDocument()
  })

  it('explains a 409: an active agent still runs the workflow', async () => {
    libraryRoutes(() => { throw new Error('API Error: 409') })
    await archiveOldFlow()
    expect(await screen.findByRole('alert')).toHaveTextContent('An active agent still runs this workflow')
  })

  it('is not shown to a non-admin, not even on its own tab', async () => {
    adminFlag.isAdmin = false
    libraryRoutes(() => ({}))
    renderList(LIBRARY)
    await screen.findByText('Autonomous agents')
    expect(screen.queryByText('Workflow library')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Workflows/ })).not.toBeInTheDocument()
  })

  it('opens on the Workflows tab from ?tab=workflows, and the Agents tab goes back to the list', async () => {
    libraryRoutes(() => ({}))
    renderList(LIBRARY)
    expect(await screen.findByText('Workflow library')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Workflows/ })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    expect(await screen.findByText('No autonomous agents yet')).toBeInTheDocument()
    expect(screen.queryByText('Workflow library')).not.toBeInTheDocument()
  })
})

describe('Agents list — a run waiting for a decision', () => {
  it('badges the agent and links straight to its runs', async () => {
    route({ 'GET /agents': () => ({ items: [agent('ag_1', 'Scout', { stats: { last_run_status: 'needs_human' } }), agent('ag_2', 'Sleeper')] }) })
    renderList()
    expect(within(rowOf(await screen.findByText('Scout'))).getByText('Needs your decision')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review the run of Scout' })).toHaveAttribute('href', '/agents/ag_1?tab=runs')
    expect(screen.getAllByText('Needs your decision')).toHaveLength(1)
  })
})

describe('Agents list — Rename and Delete', () => {
  const twoAgents = () => ({ current: [agent('ag_1', 'Scout'), agent('ag_2', 'Sleeper')] })

  it('renames an agent: only the name is sent, and the list shows the new name', async () => {
    const items = twoAgents()
    const update = vi.fn((_body: unknown) => {
      items.current = [agent('ag_1', 'Pathfinder'), agent('ag_2', 'Sleeper')]
      return { agent: agent('ag_1', 'Pathfinder') }
    })
    route({ 'GET /agents': () => ({ items: items.current }), 'PUT /agents/ag_1': update })
    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Scout' }))
    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByLabelText('Name')
    expect(field).toHaveValue('Scout')
    await userEvent.clear(field)
    await userEvent.type(field, ' Pathfinder ')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ name: 'Pathfinder' }))
    expect(await screen.findByText('Pathfinder')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the rename dialog open and says so when the rename fails', async () => {
    route({ 'GET /agents': () => ({ items: twoAgents().current }), 'PUT /agents/ag_1': () => { throw new Error('API Error: 500') } })
    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Scout' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), ' 2')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The agent couldn’t be renamed.')
  })

  it('deletes an agent only after the confirmation, and it leaves the list', async () => {
    const items = twoAgents()
    const remove = vi.fn(() => {
      items.current = [agent('ag_2', 'Sleeper')]
      return { agent: agent('ag_1', 'Scout', { status: 'archived' }) }
    })
    route({ 'GET /agents': () => ({ items: items.current }), 'DELETE /agents/ag_1': remove })
    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Scout' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Its past runs and the projects and documents it made are kept.')
    expect(remove).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    // Only Scout leaves the list: the delete was sent once, and Sleeper stays.
    await waitFor(() => expect(screen.queryByText('Scout')).not.toBeInTheDocument())
    expect([remove.mock.calls.length, screen.queryByText('Sleeper') !== null]).toStrictEqual([1, true])
  })

  it('keeps the agent when the deletion is cancelled', async () => {
    const remove = vi.fn()
    route({ 'GET /agents': () => ({ items: twoAgents().current }), 'DELETE /agents/ag_1': remove })
    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Scout' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText('Scout')).toBeInTheDocument()
  })

  it('says so when the delete fails', async () => {
    route({ 'GET /agents': () => ({ items: twoAgents().current }), 'DELETE /agents/ag_1': () => { throw new Error('API Error: 500') } })
    renderList()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Scout' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('The agent couldn’t be deleted.')).toHaveAttribute('role', 'alert')
    expect(screen.getByText('Scout')).toBeInTheDocument()
  })

  it('shows neither to a non-admin', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /agents': () => ({ items: twoAgents().current }) })
    renderList()
    await screen.findByText('Scout')
    expect(screen.queryByRole('button', { name: 'Rename Scout' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Scout' })).not.toBeInTheDocument()
  })
})
