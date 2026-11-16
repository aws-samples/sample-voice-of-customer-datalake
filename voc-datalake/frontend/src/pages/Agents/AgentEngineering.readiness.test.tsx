/**
 * @fileoverview An engineering automation's readiness before Enable (7.50.00): the Set up dialog, the agents list's
 * card and the switch show each check (passed, failing, with a warning, unknown) with its fix and doc link; Enable
 * waits while a required check does not pass, never for an advisory one (in the dialog, a check it sets itself does
 * not hold it); an Enable refused with 409 `{error, checks}` shows the checks it names; the way-of-working check links
 * to Users.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { findEngineeringTemplate } from '../../api/engineeringTemplates'
import { normalizeAgent } from '../../api/agentsApi'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { Agent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringEnableControl, EngineeringSetUpCard } = await import('./AgentEngineering')

const AGENT = 'ag_b0f1e2d3c4a5'
const READINESS = `GET /agents/engineering/readiness?automation=${AGENT}`

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

/** What a run truly needs (the server's required checks, item B of 7.50.00): the other checks are advice. */
const REQUIRED = new Set(['connection', 'ci_attestation', 'image', 'bedrock_models', 'budget', 'dial'])
const check = (id: string, status: string, extra: Record<string, string> = {}) => ({
  id, status, detail: `${id} detail`, fix: `${id} fix`, docs: 'docs/autonomous-agents.md#setup-guide',
  required: REQUIRED.has(id), ...extra,
})

function routes(checks: unknown[], extra: Record<string, RouteHandler> = {}): void {
  const template = findEngineeringTemplate('bug-hunt-and-fix')
  if (template === undefined) throw new Error('no bug-hunt-and-fix template')
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections: [CONNECTION], limit: 20 }),
    'GET /workflows/wf_1': () => workflowView(3, { ...template.definition, budget: { monthly_usd: 50 } },
      { kind: 'engineering', monthly_budget_usd: 50 }),
    [READINESS]: () => ({ checks }),
    ...extra,
  }, { missStatus: 500 })
}

const renderControl = (agent: Agent) =>
  renderWithQueryClient(<TestRouter><EngineeringEnableControl agent={agent} isAdmin /></TestRouter>)

beforeEach(() => { resetFetchApi() })

describe('the switch of a set-up agent', () => {
  const THREE = [check('network', 'pass'), check('agentcore_quota', 'warn'), check('ci_attestation', 'fail')]

  it('waits while a check a run needs fails, and says why', async () => {
    routes(THREE)
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(toggle).toBeDisabled() })
    expect(screen.getByText('Enable waits until every check a run needs passes.')).toBeInTheDocument()
  })

  it('folds the checks under their summary, failing first, then warnings, then passes', async () => {
    routes(THREE)
    renderControl(agentOf())
    await userEvent.click(await screen.findByText('Failing: 1 · Unknown: 0 · Warnings: 1 · Passed: 1'))
    expect(screen.getAllByTestId(/^readiness-/).map((row) => row.dataset.status)).toStrictEqual(['fail', 'warn', 'pass'])
    // (a check that passed shows no fix)
    expect(within(screen.getByTestId('readiness-network')).queryByText('network fix')).toBeNull()
  })

  it('shows a failing check with its name, its fix and its doc link', async () => {
    routes(THREE)
    renderControl(agentOf())
    await userEvent.click(await screen.findByText('Failing: 1 · Unknown: 0 · Warnings: 1 · Passed: 1'))
    const failing = screen.getByTestId('readiness-ci_attestation')
    expect([within(failing).getByText('CI attestation'), within(failing).getByText('ci_attestation fix')]).toHaveLength(2)
    expect(within(failing).getByRole('link', { name: /Docs/ })).toHaveAttribute('href',
      'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/autonomous-agents.md#setup-guide')
  })

  it('is on offer when only warnings remain, and a 409 from Enable shows the checks it names', async () => {
    const failing = [check('dial', 'fail', { fix: 'Set your way of working to AI-driven.' })]
    routes([check('agentcore_quota', 'warn')], {
      [`POST /agents/${AGENT}/enable`]: () => { throw new ApiError(409, 'a check a run needs fails', undefined, undefined, failing) },
    })
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith(`/agents/engineering/readiness?automation=${AGENT}`, undefined) })
    await userEvent.click(toggle)
    const alert = await screen.findByRole('alert')
    expect([within(alert).getByText('Not enabled: these checks a run needs fail.'),
      within(alert).getByText('Set your way of working to AI-driven.')]).toHaveLength(2)
    // The way-of-working check links to Users, where the administrator sets AI-driven.
    expect(within(alert).getByRole('link', { name: 'Set your way of working in Users' })).toHaveAttribute('href', '/admin/access/users')
  })

  it('waits for a required check that is unknown', async () => {
    routes([check('bedrock_models', 'unknown'), check('ci_protection', 'pass')])
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(toggle).toBeDisabled() })
  })

  it('is on offer while only an advisory check fails', async () => {
    routes([check('ci_protection', 'fail'), check('bedrock_models', 'pass')])
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith(`/agents/engineering/readiness?automation=${AGENT}`, undefined) })
    expect(toggle).toBeEnabled()
  })

  it('reads no readiness once the agent is enabled', async () => {
    routes([check('dial', 'fail')])
    renderControl(agentOf({ enabled: true }))
    expect(await screen.findByRole('switch', { name: 'Enabled' })).toBeEnabled()
    expect(fetchApi.mock.calls.some(([path]) => path.startsWith('/agents/engineering/readiness'))).toBe(false)
  })
})

describe('the Set up dialog', () => {
  it('shows the readiness, and a check it sets itself does not hold Save and enable', async () => {
    routes([check('connection', 'fail'), check('image', 'fail'), check('budget', 'pass')], {
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
      [`POST /agents/${AGENT}/enable`]: () => ({ agent: agentOf({ enabled: true }) }),
    })
    renderControl(agentOf({ engineering: { connection: null, language: null, feedback_type: 'bug' } }))
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('readiness-connection')).toHaveAttribute('data-status', 'fail')
    expect(within(dialog).getByRole('button', { name: 'Save and enable' })).toBeEnabled()
  })

  it('holds Save and enable while a check it does not set fails', async () => {
    routes([check('ci_attestation', 'fail'), check('connection', 'pass')])
    renderControl(agentOf({ engineering: { connection: null, language: null, feedback_type: 'bug' } }))
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('readiness-ci_attestation')
    expect(within(dialog).getByRole('button', { name: 'Save and enable' })).toBeDisabled()
    expect(within(dialog).getByText('Enable waits until every check a run needs passes.')).toBeInTheDocument()
  })

  it('shows the failing checks of a refused Enable, the settings saved', async () => {
    const failing = [check('image', 'fail', { fix: 'Push the node image.' })]
    routes([check('connection', 'fail')], {
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
      [`POST /agents/${AGENT}/enable`]: () => { throw new ApiError(409, 'API Error: 409', undefined, undefined, failing) },
    })
    renderControl(agentOf({ engineering: { connection: null, language: null, feedback_type: 'bug' } }))
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('readiness-connection')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByText('Push the node image.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('the agents list\'s card', () => {
  it('keeps a set-up, disabled agent whose readiness fails, with its Set up and the checks folded', async () => {
    routes([check('ci_attestation', 'fail'), check('network', 'pass')])
    renderWithQueryClient(<TestRouter><EngineeringSetUpCard agent={agentOf()} /></TestRouter>)
    const card = await screen.findByTestId('engineering-setup-card')
    expect(within(card).getByRole('button', { name: 'Set up' })).toBeInTheDocument()
    expect(within(card).getByText('Failing: 1 · Unknown: 0 · Warnings: 0 · Passed: 1')).toBeInTheDocument()
  })

  it('shows nothing for a set-up agent with nothing failing', async () => {
    routes([check('agentcore_quota', 'warn')])
    const agent = agentOf()
    renderWithQueryClient(<TestRouter><EngineeringEnableControl agent={agent} isAdmin /><EngineeringSetUpCard agent={agent} /></TestRouter>)
    expect(await screen.findByRole('switch', { name: 'Enabled' })).toBeEnabled()
    await waitFor(() => { expect(screen.getAllByText('Failing: 0 · Unknown: 0 · Warnings: 1 · Passed: 0').length).toBeGreaterThan(0) })
    expect(screen.queryByTestId('engineering-setup-card')).toBeNull()
  })
})
