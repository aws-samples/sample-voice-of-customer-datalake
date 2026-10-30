/**
 * The Decisions tab renders from the project cache entry, so a save and a delete must
 * show at once — not only after a whole-project refetch that another invalidation can
 * cancel or that is still in flight. These tests hold every refetch open forever: the
 * card can only be right if the write's own answer reached the cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useQuery } from '@tanstack/react-query'
import { render } from '../../../test/test-utils'
import { projectKey } from '../../../api/projectQueryKeys'
import type { ProjectDetail } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'
import DecisionsTab from './DecisionsTab'

const api = vi.hoisted(() => ({ createDecision: vi.fn(), updateDecision: vi.fn(), pursueDecision: vi.fn() }))
const projects = vi.hoisted(() => ({ deleteDocument: vi.fn() }))
vi.mock('../../../api/decisionsApi', () => ({ decisionsApi: api }))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: projects }))

const decisionDocument = (verdict: string, rationale: string, revision: number): ProjectDocument => Object.assign(
  { document_id: 'doc_1', document_type: 'decision', title: 'Offline mode', content: '', created_at: '2026-10-01' },
  { revision, decision: {
    verdict, rationale, success_metric: '', kill_criterion: '', evidence: { feedback_ids: [], document_ids: [] },
    review_by: null, launched_at: null, decided_by_name: 'Ana', decided_at: '2026-10-02T00:00:00Z',
  } },
)

const DETAIL: ProjectDetail = {
  project: {
    project_id: 'p1', name: 'P', description: '', status: 'active', created_at: '', updated_at: '',
    persona_count: 0, document_count: 1, visibility: 'private', owner: null, member_count: 0,
    access: { role: 'owner', can_view: true, can_edit: true, can_manage: true },
  },
  personas: [],
  documents: [decisionDocument('pursue', 'Top complaint', 1)],
}

const getProject = vi.fn<() => Promise<ProjectDetail>>()

function Harness() {
  const { data } = useQuery({ queryKey: projectKey('p1'), queryFn: getProject })
  if (data === undefined) return null
  return <DecisionsTab projectId="p1" documents={data.documents} canEdit />
}

beforeEach(() => {
  // The first read answers; every refetch after a write never does.
  getProject.mockReset().mockResolvedValueOnce(DETAIL).mockReturnValue(new Promise<ProjectDetail>(() => {}))
  api.updateDecision.mockReset().mockResolvedValue(decisionDocument('park', 'Revisit after the release', 2))
  projects.deleteDocument.mockReset().mockResolvedValue({ success: true })
})

describe('DecisionsTab after a write', () => {
  it('an edited decision shows its new values at once, while the project refetch is still running', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const card = await screen.findByRole('article', { name: 'Offline mode' })
    await user.click(within(card).getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(screen.getByRole('article', { name: 'Offline mode' })).toHaveTextContent('Revisit after the release'))
    expect(screen.getByRole('article', { name: 'Offline mode' })).toHaveTextContent('Park')
    expect(screen.queryByRole('button', { name: 'Save decision' })).not.toBeInTheDocument()
  })

  it('a second edit sends the revision the first one produced, not a stale one', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(within(await screen.findByRole('article', { name: 'Offline mode' })).getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(screen.getByRole('article', { name: 'Offline mode' })).toHaveTextContent('Park'))
    await user.click(within(screen.getByRole('article', { name: 'Offline mode' })).getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(api.updateDecision).toHaveBeenCalledTimes(2))
    expect(api.updateDecision.mock.calls[1]?.[3]).toBe(2)
  })

  it('a decision is deleted only after the confirm dialog, and leaves the list at once', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const card = await screen.findByRole('article', { name: 'Offline mode' })
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    expect(projects.deleteDocument).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete decision' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Offline mode' })).not.toBeInTheDocument())
    expect(projects.deleteDocument).toHaveBeenCalledWith('p1', 'doc_1')
  })

  it('the delete question names the decision and closes once it is deleted', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(within(await screen.findByRole('article', { name: 'Offline mode' })).getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('"Offline mode" is removed from the project for everyone.')
    await user.click(within(dialog).getByRole('button', { name: 'Delete decision' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('cancelling the delete question deletes nothing', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const card = await screen.findByRole('article', { name: 'Offline mode' })
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(projects.deleteDocument).not.toHaveBeenCalled()
    expect(screen.getByRole('article', { name: 'Offline mode' })).toBeInTheDocument()
  })

  it('a failed delete keeps the decision and says so in the dialog', async () => {
    projects.deleteDocument.mockRejectedValue(new Error('API Error: 500'))
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(within(await screen.findByRole('article', { name: 'Offline mode' })).getByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete decision' }))
    expect(await within(screen.getByRole('dialog')).findByText(/could not be deleted/)).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Offline mode' })).toBeInTheDocument()
  })
})
