/**
 * @fileoverview Agent orchestration's shell (7.52.00 C1): its header (the title, New automation on Automations), its tabs
 * in their order (Automations · Runs · Skills · Spend · Flows · Registry · Connections; only Automations and Flows
 * without the engineering agents), each a path under `/agents` that Back and Forward walk, the counts on Runs and
 * Skills (named for a screen reader), a tab switch dropping the last tab's options, the Registry's places left to its
 * page, a path off its form replaced in place, a person who is not an administrator (no tabs, Automations only), the
 * create flow, and the Flows tab's library.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { currentMonth } from '../../api/engineeringSpendApi'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
// Partial: the Plans list reaches the assistant store, which reads the real auth store.
vi.mock('../../store/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/authStore')>()),
  ...(await import('@test/fetchApiRoutes')).authStoreModule(),
}))
vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const { default: Agents, AutomationsTab, ConnectionsTab, FlowsTab, RunsTabPage, SpendTab } = await import('./Agents')
const { EngineeringSkills } = await import('./EngineeringSkills')
const { engineeringModule } = await import('@test/engineeringModule')

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  agent_id: id, name, description: '', enabled: false,
  scope: { all: true, categories: [], subcategories: [] },
  stats: { scheduled_runs_today: 0, model_calls_this_month: 42 },
  ...extra,
})

const NO_PLANS: Record<string, RouteHandler> = { 'GET /agents/plans?limit=20': () => ({ plans: [] }) }
const route = (routes: Record<string, RouteHandler>) => routeFetchApi({ ...NO_PLANS, ...routes }, { missStatus: 500 })

/** The address, for the tab a click opens and the options it keeps or drops. */
function Where() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <button type="button" onClick={() => { void navigate(-1) }}>Back</button>
      <button type="button" onClick={() => { void navigate(1) }}>Forward</button>
    </>
  )
}

/** The shell's routes as routes.tsx declares them: a layout route whose tabs are its children. */
function renderShell(entry = '/agents') {
  return renderWithQueryClient(
    <TestRouter initialEntries={['/home', entry]} initialIndex={1}>
      <Routes>
        <Route path="/agents" element={<><Agents /><Where /></>}>
          <Route index element={<AutomationsTab />} />
          <Route path="runs/*" element={<RunsTabPage />} />
          <Route path="spend/*" element={<SpendTab />} />
          <Route path="workflows/*" element={<FlowsTab />} />
          <Route path="connections/*" element={<ConnectionsTab />} />
          <Route path="skills/*" element={<EngineeringSkills />} />
          <Route path="registry/*" element={<p>Registry page</p>} />
        </Route>
        <Route path="/agents/:id/*" element={<p>Agent detail page</p>} />
        <Route path="/home" element={<p>Home page</p>} />
      </Routes>
    </TestRouter>,
  )
}

const tabNames = () => within(screen.getByRole('tablist', { name: 'Agent orchestration sections' })).getAllByRole('tab')
  .map((tab) => tab.textContent.trim())
const where = () => screen.getByTestId('where').textContent

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  engineeringModule.available = false
})

afterEach(() => { vi.useRealTimers() })

describe('the header', () => {
  it('is Agent orchestration, with New automation on Automations', async () => {
    route({ 'GET /agents': () => ({ items: [] }) })
    renderShell()
    expect(await screen.findByRole('heading', { level: 1, name: 'Agent orchestration' })).toBeInTheDocument()
    expect(screen.getByText('Agents that work on your feedback and GitHub issues, within the budgets you set.')).toHaveClass('max-w-prose')
    expect(screen.getAllByRole('button', { name: 'New automation' }).length).toBeGreaterThan(0)
  })

  it('creates a product automation, created off, and opens it', async () => {
    const create = vi.fn((_body: unknown) => ({ agent: agent('ag_new', 'Scout') }))
    route({ 'GET /agents': () => ({ items: [agent('ag_1', 'Existing')] }), 'POST /agents': create })
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: 'New automation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a product automation' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Scout')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create automation' }))
    expect(await screen.findByText('Agent detail page')).toBeInTheDocument()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Scout', scope: { all: true, categories: [], subcategories: [] } }))
  })
})

describe('the tabs', () => {
  it('are Automations · Runs · Skills · Spend · Flows · Registry · Connections with the engineering agents on', async () => {
    engineeringModule.available = true
    route({ 'GET /agents': () => ({ items: [] }) })
    renderShell()
    await screen.findByRole('tab', { name: 'Automations', selected: true })
    expect(tabNames()).toStrictEqual(['Automations', 'Runs', 'Skills', 'Spend', 'Flows', 'Registry', 'Connections'])
  })

  it('are Automations and Flows without them, and an engineering path shows Automations without reading it', async () => {
    route({ 'GET /agents': () => ({ items: [] }) })
    renderShell('/agents/spend')
    expect(await screen.findByRole('tab', { name: 'Automations', selected: true })).toBeInTheDocument()
    expect(tabNames()).toStrictEqual(['Automations', 'Flows'])
    expect(fetchApi.mock.calls.some(([path]) => path.startsWith('/agents/engineering/spend'))).toBe(false)
  })

  it('count the runs waiting for a person and the skill versions waiting for review, named for a screen reader', async () => {
    engineeringModule.available = true
    const waiting = (id: string) => ({ run_id: id, flow: 'wf_fix', goal: 'Fix', status: 'needs_human', started_at: null, ended_at: null })
    route({
      'GET /agents': () => ({ items: [] }),
      [`GET /agents/engineering/runs?month=${currentMonth()}&status=needs_human`]: () => ({ runs: [waiting('r1'), waiting('r2')], next: null }),
      'GET /agents/engineering/skills?connection=': () => ({ roles: [
        { role: 'fixer', current_version: 4, versions: 5, latest: { version: 5, status: 'proposed', summary: 'x', proposed_at: '' } },
        { role: 'hunter', current_version: 2, versions: 2, latest: { version: 2, status: 'accepted', summary: 'y', proposed_at: '' } },
      ] }),
    })
    renderShell()
    expect(await screen.findByRole('tab', { name: 'Runs (2 need you)' })).toBeInTheDocument()
    expect(await screen.findByRole('tab', { name: 'Skills (1 to review)' })).toBeInTheDocument()
  })

  it('are paths that Back and Forward walk; a switch drops the last tab\'s options', async () => {
    engineeringModule.available = true
    const user = userEvent.setup()
    route({
      'GET /agents': () => ({ items: [] }),
      'GET /workflows': () => ({ items: [] }),
      'GET /agents/engineering/spend?month=2026-10&by=run&workflow=wf_fix': () => ({
        month: '2026-10', total: { usd: 0, tokens_in: 0, tokens_out: 0, microvm_seconds: 0 }, groups: [],
      }),
    })
    renderShell('/agents/spend?month=2026-10&by=run&workflow=wf_fix')
    expect(await screen.findByRole('tab', { name: 'Spend', selected: true })).toBeInTheDocument()
    const visited = [where()]
    await user.click(screen.getByRole('tab', { name: 'Flows' }))
    visited.push(where())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    visited.push(where())
    await user.click(screen.getByRole('button', { name: 'Forward' }))
    visited.push(where())
    expect(visited).toStrictEqual(['/agents/spend?month=2026-10&by=run&workflow=wf_fix', '/agents/workflows',
      '/agents/spend?month=2026-10&by=run&workflow=wf_fix', '/agents/workflows'])
  })

  it('leave the Registry\'s places to its page, and replace a path off its form in place', async () => {
    engineeringModule.available = true
    route({ 'GET /agents': () => ({ items: [] }), 'GET /workflows': () => ({ items: [] }) })
    renderShell('/agents/registry/cards/fixer-careful')
    expect(await screen.findByText('Registry page')).toBeInTheDocument()
    expect([screen.getByRole('tab', { name: 'Registry' }).getAttribute('aria-selected'), where()])
      .toStrictEqual(['true', '/agents/registry/cards/fixer-careful'])
  })

  it('replace a path a tab does not have by the tab\'s own', async () => {
    engineeringModule.available = true
    route({ 'GET /agents': () => ({ items: [] }), 'GET /workflows': () => ({ items: [] }) })
    renderShell('/agents/workflows/unknown/deeper')
    await waitFor(() => { expect(where()).toBe('/agents/workflows') })
  })

  it('are an administrator\'s: anyone else has no tabs, Automations read only, and no engineering read', async () => {
    engineeringModule.available = true
    adminFlag.isAdmin = false
    route({ 'GET /agents': () => ({ items: [agent('ag_1', 'Scout', { enabled: true })] }) })
    renderShell('/agents/connections')
    expect(await screen.findByText('Scout')).toBeInTheDocument()
    expect([screen.queryByRole('tab'), screen.queryByRole('button', { name: 'New automation' }),
      screen.queryByRole('button', { name: 'Actions for Scout' })]).toStrictEqual([null, null, null])
    expect(fetchApi.mock.calls.some(([path]) => path.startsWith('/agents/engineering/'))).toBe(false)
  })
})

describe('the Flows tab', () => {
  const summary = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    workflow_id: id, slug: id, name, description: '', revision: 2, derived_from: null, builtin: false,
    updated_at: null, updated_by_username: null, ...extra,
  })

  it('is the library, opened from its path', async () => {
    route({
      'GET /agents': () => ({ items: [] }),
      'GET /workflows': () => ({ items: [summary('wf_default', 'Reviews → Prototype', { builtin: true }), summary('wf_old', 'Old flow')] }),
    })
    renderShell('/agents/workflows')
    expect(await screen.findByText('Old flow')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Flows' })).toHaveAttribute('aria-selected', 'true')
  })
})
