/**
 * @fileoverview Agent detail extras: the "needs your decision" banner under the
 * header (to the Runs tab), and the Workflow tab's switcher — PUT the agent's
 * workflow_id, confirm first over unsaved edits, the notice after a switch, and
 * the library link (the only control a non-admin gets).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, resetFetchApi, routeFetchApi as route, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { MINI_WORKFLOW, workflowView } from '@test/workflowFixtures'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

// Only the Instructions and Workflow tabs are opened, so no `api.*` read is needed.
vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const AGENT = {
  agent_id: 'ag_1', name: 'Scout', enabled: true, status: 'active', workflow_id: 'wf_1',
  scope: { all: true, categories: [], subcategories: [] },
  stats: { runs_total: 1, last_run_status: 'completed' },
}

const definition = (name: string) => ({ ...MINI_WORKFLOW, name })

const { default: AgentDetail } = await import('./AgentDetail')

function routes(agent: Record<string, unknown> = AGENT, extra: Record<string, Handler> = {}) {
  route({
    'GET /agents/ag_1': () => ({ agent }),
    'GET /workflows': () => ({ items: [{ workflow_id: 'wf_1', name: 'Flow', revision: 7 }, { workflow_id: 'wf_2', name: 'Fast flow', revision: 2 }] }),
    'GET /workflows/wf_1': () => workflowView(7, definition('Flow')),
    'GET /workflows/wf_2': () => workflowView(2, definition('Fast flow'), { workflow_id: 'wf_2' }),
    'GET /agents/ag_1/runs': () => ({ items: [] }),
    ...extra,
  })
}

function renderDetail(entry: string) {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents/:id" element={<AgentDetail />} />
        <Route path="/agents/workflows/:workflowId" element={<p>Workflow library page</p>} />
      </Routes>
    </TestRouter>,
  )
}

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('AgentDetail — a last run that needs a decision', () => {
  it('shows a banner whose button opens the Runs tab', async () => {
    routes({ ...AGENT, stats: { last_run_status: 'needs_human' } })
    renderDetail('/agents/ag_1?tab=instructions')
    const banner = await screen.findByText('The last run of this agent needs your decision.')
    await userEvent.click(within(banner.closest<HTMLElement>('[role="status"]') ?? banner).getByRole('button', { name: 'Review the run' }))
    expect(await screen.findByRole('tab', { name: /Runs/, selected: true })).toBeInTheDocument()
    expect(screen.queryByText('The last run of this agent needs your decision.')).not.toBeInTheDocument()
  })

  it('shows no banner otherwise', async () => {
    routes()
    renderDetail('/agents/ag_1?tab=instructions')
    await screen.findByRole('heading', { name: 'Scout' })
    expect(screen.queryByText('The last run of this agent needs your decision.')).not.toBeInTheDocument()
  })
})

describe('AgentDetail — Workflow tab switcher', () => {
  const findSwitcher = async () => {
    await screen.findByRole('option', { name: 'Fast flow' })
    return screen.getByRole('combobox', { name: 'Workflow' })
  }

  it('switches the agent to another library workflow and says so', async () => {
    const put = vi.fn((_body: unknown) => ({ agent: { ...AGENT, workflow_id: 'wf_2' } }))
    routes(AGENT, { 'PUT /agents/ag_1': put })
    renderDetail('/agents/ag_1?tab=workflow')
    await userEvent.selectOptions(await findSwitcher(), 'wf_2')
    await waitFor(() => expect(put).toHaveBeenCalledWith({ workflow_id: 'wf_2' }))
    expect(await screen.findByText('This agent now runs Fast flow.')).toBeInTheDocument()
  })

  it('asks before dropping unsaved edits, and Cancel keeps them', async () => {
    const put = vi.fn((_body: unknown) => ({ agent: { ...AGENT, workflow_id: 'wf_2' } }))
    routes(AGENT, { 'PUT /agents/ag_1': put })
    renderDetail('/agents/ag_1?tab=workflow')
    const name = await screen.findByLabelText('Workflow name')
    await userEvent.type(name, ' renamed')
    await userEvent.selectOptions(await findSwitcher(), 'wf_2')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Your unsaved changes to Flow renamed will be lost.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(put).not.toHaveBeenCalled()
  })

  it('switches after the confirmation', async () => {
    const put = vi.fn((_body: unknown) => ({ agent: { ...AGENT, workflow_id: 'wf_2' } }))
    routes(AGENT, { 'PUT /agents/ag_1': put })
    renderDetail('/agents/ag_1?tab=workflow')
    await userEvent.type(await screen.findByLabelText('Workflow name'), ' renamed')
    await userEvent.selectOptions(await findSwitcher(), 'wf_2')
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch workflow' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith({ workflow_id: 'wf_2' }))
  })

  it("shows a non-admin the workflow's name, without the switcher", async () => {
    adminFlag.isAdmin = false
    routes()
    renderDetail('/agents/ag_1?tab=workflow')
    expect(await screen.findByTitle('Flow')).toHaveTextContent('Flow')
    expect(screen.queryByRole('combobox', { name: 'Workflow' })).not.toBeInTheDocument()
  })
})
