/**
 * @fileoverview An engineering agent's Enabled control (7.47.00): "Connect a repository first" while no connection
 * it can use is stored, "Set up" while its connection, language or flow budget is missing (the budget prefilled from
 * its flow, saved only when changed), the plain switch once it is set up, and who it runs as.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { findEngineeringTemplate } from '../../api/engineeringTemplates'
import { engineeringConnectionsApi } from '../../api/engineeringConnectionsApi'
import { normalizeAgent } from '../../api/agentsApi'
import { readinessOf, usableConnections } from './engineeringAgentRules'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { Agent } from '../../api/agentsApi'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringEnableControl } = await import('./AgentEngineering')

const ISSUE = { kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7 }

function agentOf(extra: Record<string, unknown> = {}): Agent {
  const agent = normalizeAgent({
    agent_id: 'ag_b0f1e2d3c4a5', name: 'Bug fixer', enabled: false, workflow_id: 'wf_1', triggers: [ISSUE],
    engineering: { connection: null, language: null, feedback_type: 'bug' }, ...extra,
  })
  if (agent === null) throw new Error('fixture agent did not normalise')
  return agent
}

const connection = (id: string, host: 'github' | 'gitlab' = 'github') => ({
  connection_id: id, host, repository: `example-org/${id}`, default_branch: 'main',
  credential: { kind: host === 'github' ? 'app' : 'project_token', set: true, app_id: null, installation_id: null, expires_at: null },
  version: 1,
})

const bugFlow = () => {
  const template = findEngineeringTemplate('bug-hunt-and-fix')
  if (template === undefined) throw new Error('no bug-hunt-and-fix template')
  return { ...template.definition, name: 'Bug fixer workflow', budget: { monthly_usd: 50 } }
}

function routes(connections: unknown[], extra: Record<string, RouteHandler> = {}): void {
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections, limit: 20 }),
    'GET /workflows/wf_1': () => workflowView(3, bugFlow(), { kind: 'engineering', monthly_budget_usd: 50 }),
    ...extra,
  }, { missStatus: 500 })
}

function renderControl(agent: Agent): void {
  renderWithQueryClient(<TestRouter><EngineeringEnableControl agent={agent} isAdmin /></TestRouter>)
}

/** Connections as the API client reads them (through its own normaliser). */
async function storedConnections(...raw: unknown[]): Promise<EngineeringConnection[]> {
  routeFetchApi({ 'GET /agents/engineering/connections': () => ({ connections: raw, limit: 20 }) })
  return (await engineeringConnectionsApi.list()).connections
}

describe('the readiness rules', () => {
  const set = (connectionId: string) => agentOf({ engineering: { connection: connectionId, language: 'python', feedback_type: 'bug' } })

  it('needs a stored connection, a language and a budget', async () => {
    const stored = await storedConnections(connection('storefront'))
    expect(readinessOf(set('storefront'), stored, 50)).toBe('ready')
    expect(readinessOf(set('storefront'), stored, null)).toBe('set_up')
    expect(readinessOf(set('gone'), stored, 50)).toBe('set_up')
    expect(readinessOf(agentOf(), [], 50)).toBe('no_connection')
  })

  it('offers only GitHub connections to an agent with a GitHub issue trigger', async () => {
    const stored = await storedConnections(connection('storefront'), connection('docs', 'gitlab'))
    expect(usableConnections(agentOf(), stored).map((c) => c.connection_id)).toStrictEqual(['storefront'])
    expect(usableConnections(agentOf({ triggers: [] }), stored)).toHaveLength(2)
    expect(readinessOf(agentOf(), await storedConnections(connection('docs', 'gitlab')), 50)).toBe('no_connection')
  })
})

describe('EngineeringEnableControl', () => {
  beforeEach(() => { resetFetchApi() })

  it('says to connect a repository first, linking to Connections, when none is stored', async () => {
    routes([])
    renderControl(agentOf())
    const link = await screen.findByRole('link', { name: 'Connect a repository first' })
    expect(link).toHaveAttribute('href', '/agents?tab=connections')
    expect(screen.getByText('Disabled: it needs a repository connection to work on.')).toBeInTheDocument()
    expect(screen.getByText("Runs on the deployment's feedback.")).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('sets the agent up with the budget prefilled from its flow, saving the flow only when it changed', async () => {
    const user = userEvent.setup()
    const set = agentOf({ engineering: { connection: 'storefront', language: 'node', feedback_type: 'bug' } })
    routes([connection('storefront')], {
      'PUT /agents/ag_b0f1e2d3c4a5': () => ({ agent: set }),
      'POST /agents/ag_b0f1e2d3c4a5/enable': () => ({ agent: { ...set, enabled: true } }),
    })
    renderControl(agentOf())
    await user.click(await screen.findByRole('button', { name: 'Set up' }))
    expect(screen.getByLabelText('Monthly budget (USD)')).toHaveValue(50)
    await user.selectOptions(screen.getByLabelText('Language'), 'node')
    await user.click(screen.getByRole('button', { name: 'Save and enable' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument() })
    expect(sentFetchApiBody('/agents/ag_b0f1e2d3c4a5', 'PUT')).toStrictEqual({
      engineering: { connection: 'storefront', language: 'node', feedback_type: 'bug' },
    })
    sentFetchApiBody('/agents/ag_b0f1e2d3c4a5/enable', 'POST')
    expect(fetchApi.mock.calls.some(([path, options]) => path === '/workflows/wf_1' && options?.method === 'PUT')).toBe(false)
  })

  it('saves a changed budget on the flow, at the revision it read, before the agent', async () => {
    const user = userEvent.setup()
    routes([connection('storefront')], {
      'PUT /workflows/wf_1': () => workflowView(4, { ...bugFlow(), budget: { monthly_usd: 80 } }, { kind: 'engineering' }),
      'PUT /agents/ag_b0f1e2d3c4a5': () => ({ agent: agentOf() }),
      'POST /agents/ag_b0f1e2d3c4a5/enable': () => ({ agent: agentOf({ enabled: true }) }),
    })
    renderControl(agentOf())
    await user.click(await screen.findByRole('button', { name: 'Set up' }))
    const budget = screen.getByLabelText('Monthly budget (USD)')
    await user.clear(budget)
    await user.type(budget, '80')
    await user.click(screen.getByRole('button', { name: 'Save and enable' }))
    await waitFor(() => { sentFetchApiBody('/agents/ag_b0f1e2d3c4a5/enable', 'POST') })
    expect(sentFetchApiBody('/workflows/wf_1', 'PUT')).toMatchObject({
      definition: { budget: { monthly_usd: 80 } }, expected_revision: 3,
    })
  })

  it('keeps Save off for a budget off its rule and shows the server\'s refusal', async () => {
    const user = userEvent.setup()
    routes([connection('storefront')], {
      'PUT /agents/ag_b0f1e2d3c4a5': () => { throw new Error('a github_issue trigger needs a GitHub connection') },
    })
    renderControl(agentOf())
    await user.click(await screen.findByRole('button', { name: 'Set up' }))
    const budget = screen.getByLabelText('Monthly budget (USD)')
    await user.clear(budget)
    await user.type(budget, '0.001')
    expect(screen.getByRole('button', { name: 'Save and enable' })).toBeDisabled()
    expect(screen.getByText('Dollars and cents, from 0.01 to 100,000.')).toBeInTheDocument()
    await user.clear(budget)
    await user.type(budget, '50')
    await user.click(screen.getByRole('button', { name: 'Save and enable' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('is the plain switch once set up, and says who it runs as', async () => {
    routes([connection('storefront')])
    renderControl(agentOf({ enabled: true, owner_username: 'alice',
      engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' } }))
    expect(await screen.findByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Runs as alice.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change the set-up' })).toBeInTheDocument()
  })
})
