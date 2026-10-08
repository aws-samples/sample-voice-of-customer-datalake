/**
 * @fileoverview Agent detail: the tabs (and `?tab=` deep links), Save sends
 * only the changed fields, archive goes through a confirmation, enable /
 * disable, read-only for non-admins, the not-found state, and the shared
 * unsaved-changes guard (E2E F6) under a data router.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, RouterProvider, Routes, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { wfEdge, wfNode, workflowView } from '@test/workflowFixtures'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => ({
  ...m.fetchApiClientModule(),
  api: {
    getCategoriesConfig: () => m.fetchApi('/settings/categories'),
    getModelSettings: () => m.fetchApi('/settings/models'),
  },
})))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: AgentDetail } = await import('./AgentDetail')

/** Must equal the production pattern; `routes.paramNames.test.ts` pins both. */
const AGENT_DETAIL_PATH = '/agents/:id'

const AGENT = {
  agent_id: 'ag_1', name: 'Scout', description: 'Watches checkout', enabled: false, status: 'active',
  scope: { all: true, categories: [], subcategories: [] },
  instructions: 'Be brief', personas: { fixed: [], allow_generate: true },
  triggers: [{ kind: 'new_reviews', min_new: 20, cooldown_hours: 12 }],
  models: { orchestrator: null, worker: null, reviewer: null, persona: null },
  output: { visibility: 'private' }, workflow_id: 'wf_1',
  budget: { max_scheduled_runs_per_day: 2, max_model_calls_per_run: 150, monthly_call_cap: 5000 },
  stats: { runs_total: 4, scheduled_runs_today: 1, model_calls_this_month: 90 },
}

const WORKFLOW = workflowView(7, {
  schema: 'voc-workflow/1', name: 'Flow',
  nodes: [wfNode('start', 'start', 'Start'), wfNode('end', 'end', 'Done', 280, { status: 'completed' })],
  edges: [wfEdge('e1', 'start', 'end')],
  loops: [],
})

const baseRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  'GET /agents/ag_1': () => ({ agent: AGENT }),
  'GET /workflows': () => ({ items: [{ workflow_id: 'wf_1', name: 'Flow', revision: 7 }] }),
  'GET /settings/categories': () => ({ categories: [] }),
  'GET /settings/models': () => ({ available_models: [] }),
  'GET /agents/ag_1/runs': () => ({ items: [] }),
  'GET /workflows/wf_1': () => WORKFLOW,
  ...extra,
})

function renderDetail(entry = '/agents/ag_1') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents" element={<p>Agents list page</p>} />
        <Route path={AGENT_DETAIL_PATH} element={<AgentDetail />} />
      </Routes>
    </TestRouter>,
  )
}

const findHeading = () => screen.findByRole('heading', { name: 'Scout' })

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('AgentDetail — tabs', () => {
  it('renders every tab with Settings selected', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    const tabs = within(screen.getByRole('tablist', { name: 'Agent sections' })).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent.trim())).toStrictEqual(
      ['Settings', 'Triggers', 'Personas', 'Instructions', 'Models', 'Budget', 'Workflow', 'Runs'],
    )
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Name')).toHaveValue('Scout')
  })

  it('deep-links a tab with ?tab=', async () => {
    route(baseRoutes())
    renderDetail('/agents/ag_1?tab=instructions')
    await findHeading()
    expect(screen.getByRole('tab', { name: 'Instructions' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Be brief')
  })

  it('switches to the Runs tab', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled()
  })

  it("opens the agent's workflow on the Workflow tab", async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('tab', { name: 'Workflow' }))
    expect(await screen.findByText('Revision 7')).toBeInTheDocument()
  })
})

describe('AgentDetail — save', () => {
  it('sends only the changed fields', async () => {
    const update = vi.fn((body: unknown) => ({ agent: { ...AGENT, ...(typeof body === 'object' ? body : {}) } }))
    route(baseRoutes({ 'PUT /agents/ag_1': update }))
    renderDetail()
    await findHeading()
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Scout 2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ name: 'Scout 2' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  })

  it('keeps Save disabled until something changes', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
  })

  it('shows field errors and refuses to save an invalid draft', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    await userEvent.clear(screen.getByLabelText('Name'))
    expect(screen.getByRole('alert')).toHaveTextContent(/^name: /)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('discards the draft', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    await userEvent.type(screen.getByLabelText('Name'), ' changed')
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Scout')
  })

  it('reports a failed save', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    await userEvent.type(screen.getByLabelText('Name'), ' 2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("The changes couldn't be saved.")
  })
})

describe('AgentDetail — header actions', () => {
  it('archives only after the confirmation, then returns to the list', async () => {
    const archive = vi.fn((_body: unknown) => ({ agent: { ...AGENT, status: 'archived' } }))
    route(baseRoutes({ 'DELETE /agents/ag_1': archive }))
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    const dialog = await screen.findByRole('dialog')
    expect(archive).not.toHaveBeenCalledWith(undefined)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(archive).toHaveBeenCalledWith(undefined))
    expect(await screen.findByText('Agents list page')).toBeInTheDocument()
  })

  it('keeps the agent when the archive is cancelled', async () => {
    const archive = vi.fn((_body: unknown) => ({ agent: AGENT }))
    route(baseRoutes({ 'DELETE /agents/ag_1': archive }))
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(archive).not.toHaveBeenCalledWith(undefined)
    expect(screen.getByRole('heading', { name: 'Scout' })).toBeInTheDocument()
  })

  it('enables the agent from the switch', async () => {
    const enable = vi.fn((_body: unknown) => ({ agent: { ...AGENT, enabled: true } }))
    route(baseRoutes({ 'POST /agents/ag_1/enable': enable }))
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
    await waitFor(() => expect(enable).toHaveBeenCalledWith(undefined))
    expect(await screen.findByRole('switch', { name: 'Enabled', checked: true })).toBeInTheDocument()
  })
})

describe('AgentDetail — access', () => {
  it('is read-only for a non-admin', async () => {
    adminFlag.isAdmin = false
    route(baseRoutes())
    renderDetail()
    await findHeading()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeDisabled()
  })

  it('shows not found when the agent cannot be read', async () => {
    route({})
    renderDetail('/agents/ag_missing')
    expect(await screen.findByText("This agent doesn't exist or you can't see it.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All agents' })).toHaveAttribute('href', '/agents')
  })
})

// ── Unsaved-changes guard (E2E F6) ────────────────────────────────────────────
// Under a DATA router, so `useBlocker` is live: leaving with unsaved config edits
// asks first; the six config tabs share the draft and switch freely; the Save bar
// is the registered sticky action bar.

function renderInDataRouter(client = createTestQueryClient()) {
  const router = createMemoryRouter(
    [
      { path: '/agents', element: <p>Agents list page</p> },
      { path: AGENT_DETAIL_PATH, element: <AgentDetail /> },
    ],
    { initialEntries: ['/agents/ag_1'] },
  )
  renderWithQueryClient(<RouterProvider router={router} />, client)
  return router
}

/** Load the page under a data router with `extra` routes and append to the agent's name. */
async function loadAndEditName(extra: Parameters<typeof baseRoutes>[0] = {}) {
  route(baseRoutes(extra))
  const router = renderInDataRouter()
  await findHeading()
  await userEvent.type(screen.getByLabelText('Name'), ' 2')
  return router
}

/** {@link loadAndEditName}, then take the Back link (the guard should catch it). */
async function editThenLeave(extra: Parameters<typeof baseRoutes>[0] = {}) {
  const router = await loadAndEditName(extra)
  await userEvent.click(screen.getByRole('link', { name: 'All agents' }))
  return router
}

const guardDialog = () => screen.queryByRole('dialog', { name: 'Unsaved changes' })
const dialogSave = () => within(screen.getByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' })

describe('AgentDetail — unsaved-changes guard', () => {
  it('asks before the Back link leaves unsaved edits; Cancel keeps them', async () => {
    await editThenLeave()
    expect(guardDialog()).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(guardDialog()).not.toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Scout 2')
  })

  it('Discard leaves without a PUT', async () => {
    const update = vi.fn(() => ({ agent: AGENT }))
    await editThenLeave({ 'PUT /agents/ag_1': update })
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('Agents list page')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it('Save sends the PUT, then leaves', async () => {
    const update = vi.fn((body: unknown) => ({ agent: { ...AGENT, ...(typeof body === 'object' ? body : {}) } }))
    await editThenLeave({ 'PUT /agents/ag_1': update })
    // The page has its own Save; take the dialog's.
    await userEvent.click(dialogSave())
    expect(await screen.findByText('Agents list page')).toBeInTheDocument()
    expect(update).toHaveBeenCalledWith({ name: 'Scout 2' })
  })

  it('a failed Save stays on the page with the edits', async () => {
    const router = await editThenLeave()
    await userEvent.click(dialogSave())
    expect(await screen.findByText(/could not save/i)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agents/ag_1')
  })

  it('switching between config tabs keeps the draft without asking', async () => {
    await loadAndEditName()
    await userEvent.click(screen.getByRole('tab', { name: /Instructions/ }))
    expect(guardDialog()).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Settings/ }))
    expect(screen.getByLabelText('Name')).toHaveValue('Scout 2')
  })

  it('asks before the Runs tab unmounts the config draft', async () => {
    await loadAndEditName()
    await userEvent.click(screen.getByRole('tab', { name: /Runs/ }))
    await waitFor(() => expect(guardDialog()).toBeInTheDocument())
  })

  it('renders the Save bar as the sticky action bar the assistant launcher keeps clear of', async () => {
    route(baseRoutes())
    renderInDataRouter()
    await findHeading()
    const bar = screen.getByRole('button', { name: 'Save' }).closest('[data-action-bar]')
    expect(bar).not.toBeNull()
    expect(bar).toHaveClass('sticky', 'bottom-0')
  })
})

describe('AgentDetail — the shared Cancel-keeps-the-draft contract (3.00.00 R2)', () => {
  it('keeps the edit and stays guarded when the agent refetches with new stats while the dialog is open', async () => {
    const server = { current: AGENT }
    route(baseRoutes({ 'GET /agents/ag_1': () => ({ agent: server.current }) }))
    const client = createTestQueryClient()
    const mounted: { router?: ReturnType<typeof createMemoryRouter> } = {}
    await expectCancelKeepsDraftGuarded({
      mount: async () => {
        mounted.router = renderInDataRouter(client)
        await findHeading()
      },
      edit: async (user) => { await user.type(screen.getByLabelText('Name'), ' 2') },
      expectDraft: () => expect(screen.getByLabelText('Name')).toHaveValue('Scout 2'),
      leave: async (user) => { await user.click(screen.getByRole('link', { name: 'All agents' })) },
      expectStayed: () => expect(mounted.router?.state.location.pathname).toBe('/agents/ag_1'),
      expectLeft: async () => { expect(await screen.findByText('Agents list page')).toBeInTheDocument() },
      whileDialogOpen: async () => {
        // A run finished: the stored agent's stats moved, so the query hands over a new copy.
        server.current = { ...AGENT, stats: { ...AGENT.stats, runs_total: 5 }, description: 'Edited elsewhere' }
        await client.invalidateQueries()
        await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Edited elsewhere'))
      },
    })
  })
})
