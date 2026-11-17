/**
 * @fileoverview An automation's Flow tab (7.52.00 C1; the roadmap's shared-flows item): the flow it runs on the shared
 * read-only canvas (components/WorkflowEditor/FlowCanvas), nothing edited in place; Edit in Flows opens the flow's own
 * page; Run another flow ▾ offers the flows of its kind only, and points the automation at one after a confirmation
 * that it takes effect from its next run; a person who is not an administrator sees the flow alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi, sentFetchApiBody, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { wfEdge, wfNode, workflowView } from '@test/workflowFixtures'
import { normalizeAgent } from '../../api/agentsApi'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { Agent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { AgentFlowTab } = await import('./AgentFlowTab')

function agentOf(extra: Record<string, unknown> = {}): Agent {
  const agent = normalizeAgent({ agent_id: 'ag_1', name: 'Scout', enabled: true, workflow_id: 'wf_1', ...extra })
  if (agent === null) throw new Error('fixture agent did not normalise')
  return agent
}

const WORKFLOW = workflowView(4, {
  schema: 'voc-workflow/1', name: 'Reviews flow',
  nodes: [wfNode('start', 'start', 'Start'), wfNode('end', 'end', 'Done', 280, { status: 'completed' })],
  edges: [wfEdge('e1', 'start', 'end')],
  loops: [],
}, { name: 'Reviews flow' })

const LIBRARY = { items: [
  { workflow_id: 'wf_1', name: 'Reviews flow', revision: 4, kind: 'agents' },
  { workflow_id: 'wf_2', name: 'Quick research', revision: 1, kind: 'agents' },
  { workflow_id: 'wf_eng', name: 'Bug hunt', revision: 2, kind: 'engineering' },
] }

function routes(extra: Record<string, RouteHandler> = {}) {
  routeFetchApi({ 'GET /workflows/wf_1': () => WORKFLOW, 'GET /workflows': () => LIBRARY, ...extra }, { missStatus: 500 })
}

const renderTab = (agent: Agent = agentOf(), isAdmin = true) =>
  renderWithQueryClient(<TestRouter><AgentFlowTab agent={agent} isAdmin={isAdmin} /></TestRouter>)

stubResizeObserverForSuite()

beforeEach(() => { resetFetchApi() })

describe('AgentFlowTab', () => {
  it('shows the flow read only, with its revision and Edit in Flows', async () => {
    routes()
    renderTab()
    expect(await screen.findByRole('heading', { name: 'Reviews flow' })).toBeInTheDocument()
    expect(screen.getByTestId('flow-canvas')).toBeInTheDocument()
    expect(screen.getByText('Revision 4')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit in Flows' })).toHaveAttribute('href', '/agents/workflows/wf_1')
  })

  it('offers only the other flows of its kind, and points it at one after the confirmation', async () => {
    const update = vi.fn((_body: unknown) => ({ agent: agentOf({ workflow_id: 'wf_2' }) }))
    routes({ 'PUT /agents/ag_1': update })
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Run another flow' }))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['Quick research'])
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Quick research' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Scout runs “Quick research” from its next run.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Switch workflow' }))
    await waitFor(() => { expect(sentFetchApiBody('/agents/ag_1', 'PUT')).toStrictEqual({ workflow_id: 'wf_2' }) })
    expect(await screen.findByText('This agent now runs Quick research.')).toHaveAttribute('role', 'status')
  })

  it('offers an engineering automation the engineering flows', async () => {
    routes()
    renderTab(agentOf({ engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' } }))
    await userEvent.click(await screen.findByRole('button', { name: 'Run another flow' }))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['Bug hunt'])
  })

  it('shows a person who is not an administrator the flow alone', async () => {
    routes()
    renderTab(agentOf(), false)
    expect(await screen.findByTestId('flow-canvas')).toBeInTheDocument()
    expect([screen.queryByRole('link', { name: 'Edit in Flows' }), screen.queryByRole('button', { name: 'Run another flow' })])
      .toStrictEqual([null, null])
  })
})
