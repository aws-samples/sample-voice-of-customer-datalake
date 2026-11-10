/**
 * Approval cards of the memory / agents / company tools: what each preview
 * shows before the user approves, and the admin / destructive gates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('../../api/client', (importOriginal) => import('@test/fetchApiRoutes').then((h) => h.clientWithMockedFetchApi(importOriginal)))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

import ApprovalCard from './ApprovalCard'
import { resetExecutions } from './executionStore'
import type { ApprovalCardProps, ApprovalResolution, AssistantToolCall } from '../types'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, fetchApi } from '@test/fetchApiRoutes'
import { wfEdge, wfNode as node } from '@test/workflowFixtures'

const FUTURE = () => new Date(Date.now() + 10 * 60_000).toISOString()
const CURRENT = {
  schema: 'voc-workflow/1', name: 'Flow',
  nodes: [node('s', 'start', 'Start'), node('w', 'write_prfaq', 'Write PR/FAQ', 1), node('e', 'end', 'End', 2)],
  edges: [wfEdge('e1', 's', 'w'), wfEdge('e2', 'w', 'e')],
  loops: [],
}
const PROPOSED = {
  ...CURRENT,
  nodes: [CURRENT.nodes[0], CURRENT.nodes[1], node('r', 'persona_review', 'Persona review', 3), CURRENT.nodes[2]],
  edges: [CURRENT.edges[0], wfEdge('e3', 'w', 'r'), wfEdge('e4', 'r', 'e')],
}

beforeEach(() => {
  vi.clearAllMocks()
  resetExecutions()
  adminFlag.isAdmin = true
  // jsdom has no scrollIntoView (ApprovalCard scrolls its actions into view);
  // the returned teardown removes the stub again.
  return stubElementScrollIntoView()
})

function renderCard(toolCall: AssistantToolCall, risk: 'write' | 'destructive' = 'write') {
  const onResolve = vi.fn<(r: ApprovalResolution) => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  const props: ApprovalCardProps = {
    interrupt: {
      id: `approval:${toolCall.id}`, toolCallId: toolCall.id, message: 'Proposed change.', expiresAt: FUTURE(),
      metadata: { toolName: toolCall.name, risk },
    },
    page: { kind: 'agent', path: '/agents/ag_1', agentId: 'ag_1' },
    onResolve,
    toolCall,
  }
  const user = userEvent.setup()
  render(<ApprovalCard {...props} />, { wrapper })
  return { onResolve, user }
}

describe('new tool approval cards', () => {
  it('remember (company) says it is visible to everyone', () => {
    renderCard({ id: 't1', name: 'remember', args: { scope: 'company', statement: 'Customers want tracking.', kind: 'customer' } })
    const region = screen.getByRole('region', { name: 'Remember for the company' })
    expect(within(region).getByText('Company — everyone')).toBeInTheDocument()
    expect(within(region).getByText(/visible to everyone/)).toBeInTheDocument()
  })

  it('update_company_memory shows before / after, supporters and that it changes it for everyone', () => {
    renderCard({ id: 't2', name: 'update_company_memory', args: {
      memory_id: 'mem_1', previous_statement: 'Express everywhere.', statement: 'Express not in the north.', kind: 'product', supporters: 4, reason: 'New policy',
    } })
    expect(screen.getByText('4 people support the current statement.')).toBeInTheDocument()
    expect(screen.getByText('Express everywhere.')).toBeInTheDocument()
    expect(screen.getByText('Express not in the north.')).toBeInTheDocument()
    expect(screen.getByText(/for everyone/)).toBeInTheDocument()
  })

  it('update_workflow diffs the proposal against the stored current revision', async () => {
    fetchApi.mockResolvedValue({ workflow: { workflow_id: 'wf_2', name: 'Flow', revision: 2, definition: CURRENT }, revisions: [] })
    renderCard({ id: 't3', name: 'update_workflow', args: { workflow_id: 'wf_2', expected_revision: 2, definition: PROPOSED, change_summary: 'add review' } })
    expect(await screen.findByText('Flow: revision 2 → 3')).toBeInTheDocument()
    expect(screen.getByText('Persona review')).toBeInTheDocument()
    expect(screen.getByText('Write PR/FAQ → End')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('update_workflow built on an older revision warns the save will be refused', async () => {
    fetchApi.mockResolvedValue({ workflow: { workflow_id: 'wf_2', name: 'Flow', revision: 5, definition: CURRENT }, revisions: [] })
    renderCard({ id: 't4', name: 'update_workflow', args: { workflow_id: 'wf_2', expected_revision: 2, definition: PROPOSED, change_summary: 's' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('built on revision 2, but the current one is 5')
  })

  it('create_workflow lists its steps', () => {
    renderCard({ id: 't5', name: 'create_workflow', args: { definition: PROPOSED } })
    expect(screen.getByRole('region', { name: 'Create the workflow “Flow”' })).toBeInTheDocument()
    expect(screen.getByText('4 steps, 3 arrows, 0 loops')).toBeInTheDocument()
  })

  it('agent writes are admin-only: a non-admin cannot approve create_agent', () => {
    adminFlag.isAdmin = false
    renderCard({ id: 't6', name: 'create_agent', args: { name: 'Watcher', scope: { all: true, categories: [], subcategories: [] } } })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled()
  })

  it('forget_memory is destructive and executes POST /memory/{id}/forget once confirmed', async () => {
    fetchApi.mockResolvedValue({})
    const { user, onResolve } = renderCard(
      { id: 't7', name: 'forget_memory', args: { memory_id: 'mem_1', statement: 'Old fact', reason: 'wrong' } }, 'destructive',
    )
    const approve = screen.getByRole('button', { name: 'Approve and delete' })
    expect(approve).toBeDisabled()
    await user.click(screen.getByRole('checkbox'))
    await user.click(approve)
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(fetchApi).toHaveBeenCalledWith('/memory/mem_1/forget', { method: 'POST' })
  })
})
