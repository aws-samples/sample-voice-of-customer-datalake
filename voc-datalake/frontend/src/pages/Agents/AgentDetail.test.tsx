/**
 * @fileoverview An automation's page (7.52.00 C1): its tabs by kind (each a path, `/agents/<id>/<tab>`; Runs first once
 * it has run), Save sends only the changed fields, its header (the state chip, its state's one primary, its ⋯ menu with
 * Pause or Resume and Archive…), the read-only Flow tab with Edit in Flows, read-only for non-admins, the not-found
 * state, and the shared unsaved-changes guard (E2E F6) under a data router.
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
const AGENT_DETAIL_PATH = '/agents/:id/*'

const AGENT = {
  agent_id: 'ag_1', name: 'Scout', description: 'Watches checkout', enabled: false, status: 'active',
  scope: { all: true, categories: [], subcategories: [] },
  instructions: 'Be brief', personas: { fixed: [], allow_generate: true },
  triggers: [{ kind: 'new_reviews', min_new: 20, cooldown_hours: 12 }],
  models: { orchestrator: null, worker: null, reviewer: null, persona: null },
  output: { visibility: 'private' }, workflow_id: 'wf_1',
  budget: { max_scheduled_runs_per_day: 2, max_model_calls_per_run: 150, monthly_call_cap: 5000 },
  stats: { runs_total: 0, scheduled_runs_today: 1, model_calls_this_month: 90 },
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

/** The agent's page rendered and loaded: its tabs' names, in order. */
async function tabNames(): Promise<string[]> {
  renderDetail()
  await findHeading()
  return within(screen.getByRole('tablist', { name: 'Agent sections' })).getAllByRole('tab').map((tab) => tab.textContent.trim())
}

describe('AgentDetail — tabs', () => {
  it("renders a product automation's tabs, Settings open before its first run", async () => {
    route(baseRoutes())
    expect(await tabNames()).toStrictEqual(['Runs', 'Triggers', 'Settings', 'Personas', 'Flow', 'Budget & models'])
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Name')).toHaveValue('Scout')
  })

  it('opens on Runs once it has run', async () => {
    route(baseRoutes({ 'GET /agents/ag_1': () => ({ agent: { ...AGENT, stats: { ...AGENT.stats, runs_total: 3 } } }) }))
    renderDetail()
    await findHeading()
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
  })

  it("renders an engineering automation's tabs: no Personas, Budget alone", async () => {
    const engineering = { ...AGENT, engineering: { connection: null, language: null, feedback_type: 'bug' } }
    route(baseRoutes({ 'GET /agents/ag_1': () => ({ agent: engineering }), 'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }) }))
    expect(await tabNames()).toStrictEqual(['Runs', 'Triggers', 'Settings', 'Flow', 'Budget'])
  })

  it("the settings' workflow picker never offers an engineering flow", async () => {
    route(baseRoutes({
      'GET /workflows': () => ({ items: [
        { workflow_id: 'wf_1', name: 'Flow', revision: 7, kind: 'agents' },
        { workflow_id: 'wf_eng', name: 'Bug hunt', revision: 1, kind: 'engineering' },
      ] }),
    }))
    renderDetail()
    await findHeading()
    const picker = screen.getByLabelText('Workflow')
    expect(await within(picker).findByRole('option', { name: 'Flow · r7' })).toBeInTheDocument()
    expect(within(picker).queryByRole('option', { name: /Bug hunt/ })).toBeNull()
  })

  it('opens a tab from its path (/agents/<id>/<tab>); Settings holds the Instructions', async () => {
    route(baseRoutes())
    renderDetail('/agents/ag_1/settings')
    await findHeading()
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
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

  it('shows its flow read only on the Flow tab, with Edit in Flows', async () => {
    route(baseRoutes())
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('tab', { name: 'Flow' }))
    expect(await screen.findByTestId('flow-canvas')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit in Flows' })).toHaveAttribute('href', '/agents/workflows/wf_1')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})

describe('AgentDetail — category labels', () => {
  it('the header and the scope picker show configured labels, never the ids', async () => {
    route(baseRoutes({
      'GET /agents/ag_1': () => ({ agent: { ...AGENT, scope: { all: false, categories: ['technical_support'], subcategories: [] } } }),
      'GET /settings/categories': () => ({ categories: [{ name: 'technical_support', description: 'Technical support', subcategories: [] }] }),
    }))
    renderDetail()
    expect(await screen.findByText('Watches: Technical support')).toBeInTheDocument()
    expect(await screen.findByRole('checkbox', { name: 'Technical support' })).toBeChecked()
    expect(screen.queryByText(/technical_support/)).not.toBeInTheDocument()
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
    expect(screen.getByRole('alert')).toHaveTextContent('Give the agent a name of up to 80 characters.')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('an empty scope reads as a plain sentence, not the schema message', async () => {
    route(baseRoutes({
      'GET /settings/categories': () => ({ categories: [{ name: 'billing', description: 'Billing', subcategories: [] }] }),
    }))
    renderDetail()
    await findHeading()
    await userEvent.click(screen.getByRole('checkbox', { name: 'All categories' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Choose at least one category or subcategory, or watch all categories.')
    expect(alert).not.toHaveTextContent(/scope|all=true/)
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

/** Opens the header's ⋯ menu and chooses `item`. */
async function chooseInMenu(item: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Actions for Scout' }))
  await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: item }))
}

describe('AgentDetail — header actions', () => {
  it('archives only after the confirmation, then returns to the list', async () => {
    const archive = vi.fn((_body: unknown) => ({ agent: { ...AGENT, status: 'archived' } }))
    route(baseRoutes({ 'DELETE /agents/ag_1': archive }))
    renderDetail()
    await findHeading()
    await chooseInMenu('Archive…')
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
    await chooseInMenu('Archive…')
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(archive).not.toHaveBeenCalledWith(undefined)
    expect(screen.getByRole('heading', { name: 'Scout' })).toBeInTheDocument()
  })

  it('enables the automation from its state\'s one primary, then its chip says so', async () => {
    const enable = vi.fn((_body: unknown) => ({ agent: { ...AGENT, enabled: true } }))
    route(baseRoutes({ 'POST /agents/ag_1/enable': enable }))
    renderDetail()
    await findHeading()
    expect(screen.getByText('Ready')).toHaveClass('badge-muted')
    await userEvent.click(screen.getByRole('button', { name: 'Enable Scout' }))
    await waitFor(() => expect(enable).toHaveBeenCalledWith(undefined))
    expect(await screen.findByText('Enabled')).toHaveClass('badge-ok')
    expect(screen.getByRole('status')).toHaveTextContent('Scout enabled.')
  })

  it('pauses an automation that is on from its menu, and offers Resume once paused (audited by the server)', async () => {
    const server: { agent: Record<string, unknown> } = { agent: { ...AGENT, enabled: true } }
    const pause = vi.fn((_body: unknown) => { server.agent = { ...server.agent, paused: true }; return { agent: server.agent } })
    route(baseRoutes({ 'GET /agents/ag_1': () => ({ agent: server.agent }), 'POST /agents/ag_1/pause': pause }))
    renderDetail()
    await findHeading()
    await chooseInMenu('Pause')
    await waitFor(() => expect(pause).toHaveBeenCalledWith(undefined))
    expect(await screen.findByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume Scout' })).toBeInTheDocument()
  })
})

describe('AgentDetail — access', () => {
  it('is read-only for a non-admin', async () => {
    adminFlag.isAdmin = false
    route(baseRoutes())
    renderDetail()
    await findHeading()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect([screen.queryByRole('button', { name: 'Save' }), screen.queryByRole('button', { name: 'Actions for Scout' }),
      screen.queryByRole('button', { name: 'Enable Scout' })]).toStrictEqual([null, null, null])
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('shows not found when the agent cannot be read', async () => {
    route({})
    renderDetail('/agents/ag_missing')
    expect(await screen.findByText("This automation doesn't exist or you can't see it.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Automations' })).toHaveAttribute('href', '/agents')
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
  await userEvent.click(screen.getByRole('link', { name: 'Automations' }))
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
    await userEvent.click(screen.getByRole('tab', { name: /Triggers/ }))
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
      leave: async (user) => { await user.click(screen.getByRole('link', { name: 'Automations' })) },
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
