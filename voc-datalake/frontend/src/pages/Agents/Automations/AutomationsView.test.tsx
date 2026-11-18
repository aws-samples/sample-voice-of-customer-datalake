/**
 * @fileoverview Agent orchestration → Automations (7.52.00 C1; ux-agents-redesign part 1 §2.3, part 4 §4.4): the groups
 * (Engineering first, then Product), each row's chip, last run and usage with its one button and its ⋯ menu inside
 * it, the exact Paused state (Resume as its primary, POST …/resume) and Pause from the menu (POST …/pause, said in a
 * status line), "N to fix" opening the Set up drawer at its readiness, the first-run prompt, the one blocker banner,
 * Needs you, the empty state, and a person who is not an administrator (the chip alone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { findEngineeringTemplate } from '../../../api/engineeringTemplates'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))
vi.mock('../../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const { AutomationsTab } = await import('../Agents')
const { engineeringModule } = await import('@test/engineeringModule')

const product = (extra: Record<string, unknown> = {}) => ({
  agent_id: 'ag_p', name: 'Autonomous Product', description: 'Watches every review', enabled: false, workflow_id: 'wf_default',
  scope: { all: true, categories: [], subcategories: [] },
  stats: { runs_total: 0, scheduled_runs_today: 0, model_calls_this_month: 214 }, ...extra,
})
const ENGINEERING = { connection: 'storefront', language: 'python', feedback_type: 'bug' }
const fixer = (extra: Record<string, unknown> = {}) => ({
  agent_id: 'ag_b', name: 'Bug fixer', description: 'Fixes a triaged bug.', enabled: false, workflow_id: 'wf_fix',
  scope: { all: true, categories: [], subcategories: [] }, engineering: ENGINEERING,
  triggers: [{ kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7, stage: 'act' }],
  stats: { runs_total: 0, scheduled_runs_today: 0, model_calls_this_month: 0 }, ...extra,
})
const CONNECTION = {
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: null, installation_id: null, expires_at: null }, version: 1,
}
const check = (id: string, status: string) => ({ id, status, detail: '', fix: `${id} fix`, docs: '', required: true })
const FLOWS = { items: [{ workflow_id: 'wf_fix', name: 'Bug fixer flow', revision: 2, kind: 'engineering', monthly_budget_usd: 50 }] }

const NO_PLANS: Record<string, RouteHandler> = { 'GET /agents/plans?limit=20': () => ({ plans: [] }) }
const route = (routes: Record<string, RouteHandler>) => routeFetchApi({ ...NO_PLANS, ...routes }, { missStatus: 500 })

/** An engineering deployment's reads: the connections, the flows, and the setup guide's progress (a choice made). */
function engineeringRoutes(agents: unknown[], extra: Record<string, RouteHandler> = {}, connections: unknown[] = [CONNECTION]) {
  const template = findEngineeringTemplate('bug-hunt-and-fix')
  if (template === undefined) throw new Error('no bug-hunt-and-fix template')
  route({
    'GET /agents': () => ({ items: agents }),
    'GET /agents/engineering/connections': () => ({ connections, limit: 20 }),
    'GET /workflows': () => FLOWS,
    'GET /agents/engineering/setup': () => ({ revision: 1, intro: 'skipped', steps: {} }),
    'GET /workflows/wf_fix': () => workflowView(2, { ...template.definition, budget: { monthly_usd: 50 } }, { kind: 'engineering', monthly_budget_usd: 50 }),
    ...extra,
  })
}

function renderList() {
  return renderWithQueryClient(
    <TestRouter initialEntries={['/agents']}>
      <Routes>
        <Route path="/agents" element={<AutomationsTab />} />
        <Route path="/agents/:id/*" element={<p>Agent detail page</p>} />
        <Route path="/agents/connections" element={<p>Connections page</p>} />
      </Routes>
    </TestRouter>,
  )
}

const rowOf = async (id: string) => within(await screen.findByTestId(`automation-${id}`))

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  engineeringModule.available = false
})

describe('the list', () => {
  it('puts the engineering automations first, then the product ones, each under its heading', async () => {
    engineeringModule.available = true
    engineeringRoutes([product(), fixer()], { 'GET /agents/engineering/readiness?automation=ag_b': () => ({ checks: [check('image', 'pass')] }) })
    renderList()
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map((heading) => heading.textContent)
    expect(headings).toStrictEqual(['Engineering automations', 'Product automations'])
  })

  it('shows each row\'s chip, last run and usage, with its one button and its ⋯ menu inside the row', async () => {
    route({ 'GET /agents': () => ({ items: [product()] }), 'GET /workflows': () => ({ items: [] }) })
    renderList()
    const row = await rowOf('ag_p')
    expect([row.getByText('Ready').className.includes('badge-muted'), row.queryByText('No runs yet')?.tagName,
      row.queryByText('214 of 5,000 model calls')?.tagName]).toStrictEqual([true, 'SPAN', 'SPAN'])
    expect([row.getByRole('button', { name: 'Enable Autonomous Product' }), row.getAllByRole('button', { name: 'Actions for Autonomous Product' }).length > 0])
      .toStrictEqual([expect.anything(), true])
    expect(row.getByRole('link', { name: 'Autonomous Product' })).toHaveAttribute('href', '/agents/ag_p')
  })

  it('says it is empty with New automation for an administrator', async () => {
    route({ 'GET /agents': () => ({ items: [] }) })
    renderList()
    expect(await screen.findByText('No automations yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New automation' })).toBeInTheDocument()
  })

  it('shows a person who is not an administrator the chip alone, no button and no menu', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /agents': () => ({ items: [product({ enabled: true })] }) })
    renderList()
    const row = await rowOf('ag_p')
    expect(row.getByText('Enabled')).toHaveClass('badge-ok')
    expect(row.queryAllByRole('button')).toStrictEqual([])
  })
})

describe('the exact Paused state (7.52.00)', () => {
  it('shows Paused with Resume, and Resume sends the resume', async () => {
    const server: { agent: Record<string, unknown> } = { agent: product({ enabled: true, paused: true, paused_at: '2026-11-16T10:00:00Z', paused_by: 'admin' }) }
    const resume = vi.fn((_body: unknown) => { server.agent = { ...server.agent, paused: false }; return { agent: server.agent } })
    route({ 'GET /agents': () => ({ items: [server.agent] }), 'POST /agents/ag_p/resume': resume })
    renderList()
    const row = await rowOf('ag_p')
    expect(row.getByText('Paused')).toHaveClass('badge-muted')
    await userEvent.click(row.getByRole('button', { name: 'Resume Autonomous Product' }))
    await waitFor(() => { expect(resume).toHaveBeenCalledWith(undefined) })
    expect(await row.findByText('Autonomous Product resumed.')).toHaveAttribute('role', 'status')
  })

  it('pauses an automation that is on from its ⋯ menu, which then offers Resume', async () => {
    const server: { agent: Record<string, unknown> } = { agent: product({ enabled: true }) }
    const pause = vi.fn((_body: unknown) => { server.agent = { ...server.agent, paused: true }; return { agent: server.agent } })
    route({ 'GET /agents': () => ({ items: [server.agent] }), 'POST /agents/ag_p/pause': pause })
    renderList()
    const row = await rowOf('ag_p')
    await userEvent.click(row.getAllByRole('button', { name: 'Actions for Autonomous Product' })[0] ?? document.body)
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent))
      .toStrictEqual(['Open', 'Edit settings', 'Rename…', 'Pause', 'Turn off', 'Delete…'])
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Pause' }))
    await waitFor(() => { expect(pause).toHaveBeenCalledWith(undefined) })
    expect(await row.findByText(/Autonomous Product paused/)).toHaveAttribute('role', 'status')
  })
})

describe('an engineering automation', () => {
  it('counts the checks to fix, and "N to fix" opens the Set up drawer at its readiness', async () => {
    engineeringModule.available = true
    const failing = { checks: [check('ci_attestation', 'fail'), check('image', 'pass')] }
    engineeringRoutes([fixer()], {
      'GET /agents/engineering/readiness?automation=ag_b': () => failing,
      'GET /agents/engineering/readiness?automation=ag_b&connection=storefront&language=python': () => failing,
    })
    renderList()
    const row = await rowOf('ag_b')
    expect(await row.findByText('Needs setup')).toHaveClass('badge-warn')
    await userEvent.click(row.getByRole('button', { name: /1 to fix/ }))
    const drawer = await screen.findByRole('dialog', { name: 'Set up Bug fixer' })
    const heading = await within(drawer).findByRole('heading', { name: /Before it can run/ })
    await waitFor(() => { expect(heading).toHaveFocus() })
  })

  it('says once, for the group, that a GitHub connection is needed while none it can use exists', async () => {
    engineeringModule.available = true
    engineeringRoutes([fixer({ engineering: { ...ENGINEERING, connection: null } })], {
      'GET /agents/engineering/readiness?automation=ag_b': () => ({ checks: [] }),
    }, [])
    renderList()
    expect(await screen.findByText('These automations need a GitHub connection.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute('href', '/agents/connections')
    expect((await rowOf('ag_b')).queryByRole('button', { name: /^Set up/ })).toBeNull()
  })

  it('offers the first-run prompt in the group while nothing is set up and no choice was made', async () => {
    engineeringModule.available = true
    engineeringRoutes([fixer()], {
      'GET /agents/engineering/setup': () => ({ revision: 1, intro: 'unseen', steps: {} }),
      'GET /agents/engineering/readiness?automation=ag_b': () => ({ checks: [] }),
    }, [])
    renderList()
    const prompt = await screen.findByTestId('setup-prompt')
    expect([within(prompt).getByRole('heading', { name: 'Set up the bug loop' }), within(prompt).getByRole('button', { name: 'Start the setup guide' })])
      .toHaveLength(2)
    expect(screen.queryByText('These automations need a GitHub connection.')).toBeNull()
  })
})

describe('Needs you', () => {
  it('lists an automation whose last run waits for a person, with Review to its runs', async () => {
    route({ 'GET /agents': () => ({ items: [product({ enabled: true, stats: { runs_total: 1, last_run_status: 'needs_human' } })] }) })
    renderList()
    const section = await screen.findByRole('region', { name: 'Needs you (1)' })
    expect(within(section).getByRole('link', { name: 'Review Autonomous Product' })).toHaveAttribute('href', '/agents/ag_p/runs')
    expect(fetchApi.mock.calls.some(([path]) => path.startsWith('/agents/engineering/skills'))).toBe(false)
  })

  it('is hidden while nothing waits', async () => {
    route({ 'GET /agents': () => ({ items: [product()] }) })
    renderList()
    await rowOf('ag_p')
    expect(screen.queryByRole('region', { name: /Needs you/ })).toBeNull()
  })
})
