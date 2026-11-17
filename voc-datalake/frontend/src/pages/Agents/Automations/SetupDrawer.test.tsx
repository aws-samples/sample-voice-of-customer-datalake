/**
 * @fileoverview The Set up drawer (7.52.00 C1; ux-agents-redesign part 1 §2.4, part 2 S5): the shared side sheet, named
 * by its title; the repository `owner/name` first; the readiness of its selection (read again when it changes); Save
 * while a check holds Enable ("Enable waits for N fixes"), Save and enable once nothing does (the budget, which it
 * saves itself, never holds it); an Enable refused with 409 lists the checks it names; opened from "N to fix" it puts
 * the focus on its readiness heading; Escape closes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { findEngineeringTemplate } from '../../../api/engineeringTemplates'
import { normalizeAgent } from '../../../api/agentsApi'
import { ApiError } from '../../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { Agent } from '../../../api/agentsApi'
import type { DrawerFocus } from './SetupDrawer'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { SetupDrawer } = await import('./SetupDrawer')

const AGENT = 'ag_b0f1e2d3c4a5'
const previewOf = (connection: string, language = 'python') =>
  `GET /agents/engineering/readiness?automation=${AGENT}&connection=${connection}&language=${language}`
const BASE_READINESS = `GET /agents/engineering/readiness?automation=${AGENT}`

function agentOf(extra: Record<string, unknown> = {}): Agent {
  const agent = normalizeAgent({
    agent_id: AGENT, name: 'Bug fixer', enabled: false, workflow_id: 'wf_1',
    triggers: [{ kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7 }],
    engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' }, ...extra,
  })
  if (agent === null) throw new Error('fixture agent did not normalise')
  return agent
}

const CONNECTION = {
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: null, installation_id: null, expires_at: null }, version: 1,
}
const SANDBOX = { ...CONNECTION, connection_id: 'voc-agents-sandbox', repository: 'example-org/voc-agents-sandbox' }

const REQUIRED = new Set(['connection', 'ci_attestation', 'image', 'budget', 'dial'])
const check = (id: string, status: string) => ({
  id, status, detail: `${id} detail`, fix: `${id} fix`, docs: 'docs/autonomous-agents.md#setup-guide', required: REQUIRED.has(id),
})
const PASSING = ['connection', 'ci_attestation', 'image', 'dial'].map((id) => check(id, 'pass'))

function routes(extra: Record<string, RouteHandler> = {}, connections: unknown[] = [CONNECTION]): void {
  const template = findEngineeringTemplate('bug-hunt-and-fix')
  if (template === undefined) throw new Error('no bug-hunt-and-fix template')
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections, limit: 20 }),
    'GET /workflows/wf_1': () => workflowView(3, { ...template.definition, budget: { monthly_usd: 50 } },
      { kind: 'engineering', monthly_budget_usd: 50 }),
    [BASE_READINESS]: () => ({ checks: PASSING }),
    [previewOf('storefront')]: () => ({ checks: PASSING }),
    ...extra,
  }, { missStatus: 500 })
}

function renderDrawer(agent: Agent = agentOf(), focus: DrawerFocus = 'fields', onSaved = vi.fn(), onClose = vi.fn()) {
  renderWithQueryClient(<TestRouter><SetupDrawer agent={agent} focus={focus} onClose={onClose} onSaved={onSaved} /></TestRouter>)
  return { onSaved, onClose }
}

const sheet = () => screen.findByRole('dialog', { name: 'Set up Bug fixer' })

beforeEach(() => { resetFetchApi() })

describe('SetupDrawer', () => {
  it('is the side sheet, named by its title, with the repository as text when only one can be used', async () => {
    routes()
    renderDrawer()
    const drawer = await sheet()
    expect(drawer).toHaveClass('sheet-panel')
    expect(await within(drawer).findByText('example-org/storefront')).toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: 'Change in Connections' })).toHaveAttribute('href', '/agents/connections')
  })

  it('offers the repositories `owner/name` first when several can be used, and reads the readiness of the selection', async () => {
    routes({ [previewOf('voc-agents-sandbox')]: () => ({ checks: [check('ci_attestation', 'fail'), ...PASSING.slice(2)] }) },
      [CONNECTION, SANDBOX])
    renderDrawer()
    const select = await screen.findByLabelText(/Repository/)
    expect(within(select).getAllByRole('option').map((option) => option.textContent))
      .toStrictEqual(['example-org/storefront', 'example-org/voc-agents-sandbox'])
    await userEvent.selectOptions(select, 'voc-agents-sandbox')
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith(previewOf('voc-agents-sandbox').slice(4), undefined) })
    expect(await screen.findByText('Enable waits for 1 fix.')).toHaveAttribute('role', 'status')
  })

  it('saves without enabling while a check holds Enable, naming how many', async () => {
    const holding = [check('ci_attestation', 'fail'), check('dial', 'fail'), check('image', 'pass')]
    routes({
      [previewOf('storefront')]: () => ({ checks: holding }),
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
    })
    const { onSaved } = renderDrawer()
    expect(await screen.findByText('Enable waits for 2 fixes.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(onSaved).toHaveBeenCalledTimes(1) })
    expect([sentFetchApiBody(`/agents/${AGENT}`, 'PUT'), fetchApi.mock.calls.some(([path]) => path.endsWith('/enable'))])
      .toStrictEqual([{ engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' } }, false])
  })

  it('saves and enables once nothing holds it: the budget it sets itself never does', async () => {
    routes({
      [previewOf('storefront')]: () => ({ checks: [...PASSING, check('budget', 'fail')] }),
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
      [`POST /agents/${AGENT}/enable`]: () => ({ agent: agentOf({ enabled: true }) }),
    })
    const { onSaved } = renderDrawer()
    await userEvent.click(await screen.findByRole('button', { name: 'Save and enable' }))
    await waitFor(() => { expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), true) })
  })

  it('lists the checks a refused Enable names, the settings saved', async () => {
    const failing = [check('dial', 'fail')]
    routes({
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
      [`POST /agents/${AGENT}/enable`]: () => { throw new ApiError(409, 'a check a run needs fails', undefined, undefined, failing) },
    })
    renderDrawer()
    await userEvent.click(await screen.findByRole('button', { name: 'Save and enable' }))
    const alert = await screen.findByRole('alert')
    expect([within(alert).getByText('Not enabled: these checks a run needs fail.'), within(alert).getByText('dial fix')]).toHaveLength(2)
  })

  it('opened from "N to fix", puts the focus on its readiness heading', async () => {
    routes({ [previewOf('storefront')]: () => ({ checks: [check('ci_attestation', 'fail'), ...PASSING.slice(2)] }) })
    renderDrawer(agentOf(), 'readiness')
    const heading = await screen.findByRole('heading', { name: /Before it can run/ })
    await waitFor(() => { expect(heading).toHaveFocus() })
    expect(within(heading).getByText('1 to fix')).toBeInTheDocument()
  })

  it('offers Save alone for an automation already on, and closes on Escape', async () => {
    routes()
    const { onClose } = renderDrawer(agentOf({ enabled: true }))
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
