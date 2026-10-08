/**
 * @fileoverview Autonomous agents list: rows with state and scope, the admin
 * vs user empty states, the admin create flow (POST then navigate to the new
 * agent), no create button for non-admins, and the load failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: Agents } = await import('./Agents')

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  agent_id: id, name, description: '', enabled: false,
  scope: { all: true, categories: [], subcategories: [] },
  stats: { scheduled_runs_today: 1, model_calls_this_month: 42 },
  ...extra,
})

const route = (routes: Record<string, RouteHandler>) => routeFetchApi(routes, { missStatus: 500 })

function renderList() {
  return renderWithQueryClient(
    <TestRouter initialEntries={['/agents']}>
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
    expect(await screen.findByText('Watches: delivery, app / login')).toBeInTheDocument()
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
  renderList()
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
    renderList()
    expect(await screen.findByText('Reviews → Prototype')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive Reviews → Prototype' })).not.toBeInTheDocument()
  })

  it('explains a 409: an active agent still runs the workflow', async () => {
    libraryRoutes(() => { throw new Error('API Error: 409') })
    await archiveOldFlow()
    expect(await screen.findByRole('alert')).toHaveTextContent('An active agent still runs this workflow')
  })

  it('is not shown to a non-admin', async () => {
    adminFlag.isAdmin = false
    libraryRoutes(() => ({}))
    renderList()
    await screen.findByText('Autonomous agents')
    expect(screen.queryByText('Workflow library')).not.toBeInTheDocument()
  })
})
