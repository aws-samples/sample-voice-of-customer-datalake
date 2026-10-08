import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { at } from '@test/defined'
import type { ReactNode } from 'react'

const m = vi.hoisted(() => ({
  isAdmin: { value: true },
  projectsApi: {
    createProject: vi.fn(),
    deleteDocument: vi.fn(),
    updateDocument: vi.fn(),
    getProject: vi.fn(),
    generatePersonas: vi.fn(),
  },
  scrapersApi: { runScraper: vi.fn() },
  api: { getBrandSettings: vi.fn(), saveBrandSettings: vi.fn() },
}))

vi.mock('../../api/projectsApi', () => ({ projectsApi: m.projectsApi }))
vi.mock('../../api/scrapersApi', () => ({ scrapersApi: m.scrapersApi }))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, api: { ...actual.api, ...m.api } }
})
vi.mock('../../store/authStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/authStore')>()
  return { ...actual, useIsAdmin: () => m.isAdmin.value }
})

import ApprovalCard from './ApprovalCard'
import { resetExecutions } from './executionStore'
import { BRAND_CHANGED_MESSAGE } from './executors'
import { useConfigStore } from '../../store/configStore'
import type { ApprovalCardProps, ApprovalResolution } from '../types'

const P = 'proj_1'
const FUTURE = () => new Date(Date.now() + 10 * 60_000).toISOString()

// jsdom has no scrollIntoView; the returned teardown removes the stub again.
beforeEach(() => stubElementScrollIntoView())

beforeEach(() => {
  vi.clearAllMocks()
  resetExecutions()
  m.isAdmin.value = true
  m.projectsApi.getProject.mockResolvedValue({
    project: { project_id: P, name: 'Checkout revamp' },
    personas: [],
    documents: [{ document_id: 'd1', title: 'PRD v1', content: 'line a\nline b\nline c', document_type: 'prd' }],
  })
})

function renderCard(overrides: Partial<ApprovalCardProps> & Pick<ApprovalCardProps, 'toolCall'>) {
  const onResolve = vi.fn<(r: ApprovalResolution) => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const props: ApprovalCardProps = {
    interrupt: {
      id: `approval:${overrides.toolCall.id}`,
      toolCallId: overrides.toolCall.id,
      message: 'The assistant wants to make a change.',
      expiresAt: FUTURE(),
      metadata: { toolName: overrides.toolCall.name, risk: 'write' },
    },
    page: { kind: 'project', path: `/projects/${P}`, projectId: P },
    onResolve,
    ...overrides,
  }
  const user = userEvent.setup()
  const utils = render(<ApprovalCard {...props} />, { wrapper })
  return { ...utils, onResolve, user }
}

const createProjectCall = { id: 'tc1', name: 'create_project', args: { name: 'Acme' } }

type CardUser = ReturnType<typeof userEvent.setup>
type ResolveMock = ReturnType<typeof renderCard>['onResolve']

function expectBothActionsDisabled() {
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled()
}

/** Decline (opens the reason step), Decline again with no reason → declined, no reason. */
async function declineWithoutReason(user: CardUser, onResolve: ResolveMock) {
  await user.click(screen.getByRole('button', { name: 'Decline' }))
  await user.click(screen.getByRole('button', { name: 'Decline' }))
  expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ outcome: { status: 'declined' } }))
}

function lastOutcomeStatus(onResolve: ResolveMock) {
  return onResolve.mock.lastCall?.[0].outcome.status
}

describe('ApprovalCard', () => {
  it('renders a labelled region with title, message and preview, and takes focus', () => {
    renderCard({ toolCall: createProjectCall })
    const region = screen.getByRole('region', { name: 'Create project “Acme”' })
    expect(region).toHaveFocus()
    expect(within(region).getByText('The assistant wants to make a change.')).toBeInTheDocument()
    expect(within(region).getByText('Acme')).toBeInTheDocument()
    expect(within(region).getByText(/Expires in/)).toBeInTheDocument()
  })

  // In the 600px bubble the card focuses without scrolling (the list auto-scrolls
  // to its own end, above the cards), so the action row must bring itself into view.
  it('scrolls its Approve/Decline row into view (nearest edge) when it appears', () => {
    renderCard({ toolCall: createProjectCall })
    const actions = screen.getByTestId('approval-actions')
    expect(within(actions).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toStrictEqual([actions])
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('approve → executes once and resolves executed with the summary', async () => {
    m.projectsApi.createProject.mockResolvedValue({ success: true, project: { project_id: 'proj_new' } })
    const { onResolve, user } = renderCard({ toolCall: createProjectCall })
    await user.dblClick(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(m.projectsApi.createProject).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith({
      interruptId: 'approval:tc1',
      toolCallId: 'tc1',
      outcome: { status: 'executed', summary: 'Created project "Acme" (proj_new).', data: { project_id: 'proj_new' } },
    })
  })

  it('after approval the card shows Done and no longer offers Approve', async () => {
    m.projectsApi.createProject.mockResolvedValue({ success: true, project: { project_id: 'proj_new' } })
    const { user } = renderCard({ toolCall: createProjectCall })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Done')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('shows a spinner and disables the buttons while executing', async () => {
    m.projectsApi.createProject.mockReturnValue(new Promise(() => {}))
    const { user } = renderCard({ toolCall: createProjectCall })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    expectBothActionsDisabled()
  })

  it('a thrown error resolves failed with a safe message (403 → no permission)', async () => {
    m.projectsApi.createProject.mockRejectedValue(new Error('API Error: 403'))
    const { onResolve, user } = renderCard({ toolCall: createProjectCall })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { status: 'failed', error: "You don't have permission to do this." },
    })))
    expect(await screen.findByText('Failed')).toBeInTheDocument()
  })

  it('decline with an optional reason', async () => {
    const { onResolve, user } = renderCard({ toolCall: createProjectCall })
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    const reason = screen.getByLabelText('Reason (optional)')
    expect(reason).toHaveFocus()
    await user.type(reason, 'wrong name')
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ outcome: { status: 'declined', reason: 'wrong name' } }))
    expect(m.projectsApi.createProject).not.toHaveBeenCalled()
    expect(screen.getByText('Declined')).toBeInTheDocument()
  })

  it('decline without a reason omits it; Back returns to the buttons', async () => {
    const { onResolve, user } = renderCard({ toolCall: createProjectCall })
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    await declineWithoutReason(user, onResolve)
  })

  it('an expired interrupt offers only Dismiss, which declines with reason "expired"', async () => {
    const { onResolve, user } = renderCard({
      toolCall: createProjectCall,
      interrupt: { id: 'approval:tc1', toolCallId: 'tc1', expiresAt: new Date(Date.now() - 1000).toISOString() },
    })
    expect(screen.getAllByText('Expired').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ outcome: { status: 'declined', reason: 'expired' } }))
  })

  describe('destructive tools', () => {
    const renderDelete = () => renderCard({
      toolCall: { id: 'tc2', name: 'delete_document', args: { project_id: P, document_id: 'd1', reason: 'dup' } },
      interrupt: { id: 'approval:tc2', toolCallId: 'tc2', expiresAt: FUTURE(), metadata: { risk: 'destructive', projectId: P } },
    })

    it('keep the danger Approve disabled until the explicit confirmation is ticked', async () => {
      const { user } = renderDelete()
      const approve = screen.getByRole('button', { name: 'Approve and delete' })
      expect(approve).toBeDisabled()
      expect(approve).toHaveClass('btn-danger-solid')
      expect(await screen.findByText('Checkout revamp')).toBeInTheDocument()
      await user.click(screen.getByRole('checkbox', { name: 'I understand, delete it' }))
      expect(approve).toBeEnabled()
    })

    it('run the delete once confirmed and approved', async () => {
      m.projectsApi.deleteDocument.mockResolvedValue({ success: true })
      const { onResolve, user } = renderDelete()
      await user.click(screen.getByRole('checkbox', { name: 'I understand, delete it' }))
      await user.click(screen.getByRole('button', { name: 'Approve and delete' }))
      await waitFor(() => expect(lastOutcomeStatus(onResolve)).toBe('executed'))
      expect(m.projectsApi.deleteDocument).toHaveBeenCalledWith(P, 'd1')
    })
  })

  it('admin-only tools: a non-admin cannot approve but can decline', async () => {
    m.isAdmin.value = false
    const { onResolve, user } = renderCard({
      toolCall: { id: 'tc3', name: 'run_scraper', args: { scraper_id: 's1' } },
      page: { kind: 'scrapers', path: '/scrapers' },
    })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByText(/Only administrators can approve/)).toBeInTheDocument()
    await declineWithoutReason(user, onResolve)
    expect(m.scrapersApi.runScraper).not.toHaveBeenCalled()
  })

  it('invalid args show the validation problem and allow Decline only', async () => {
    const { onResolve, user } = renderCard({ toolCall: { id: 'tc4', name: 'create_project', args: { name: '' } } })
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid/)
    expect(screen.getByRole('alert')).toHaveTextContent(/name/)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    await declineWithoutReason(user, onResolve)
  })

  it('an unknown tool cannot be approved', () => {
    renderCard({ toolCall: { id: 'tc5', name: 'drop_everything', args: {} } })
    expect(screen.getByRole('region', { name: 'Unknown action (drop_everything)' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/isn't available/)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('the disabled prop blocks both actions', () => {
    renderCard({ toolCall: createProjectCall, disabled: true })
    expectBothActionsDisabled()
  })

  it('update_document previews a line diff against the stored document', async () => {
    renderCard({
      toolCall: {
        id: 'tc6',
        name: 'update_document',
        args: { project_id: P, document_id: 'd1', content: 'line a\nline B\nline c', change_summary: 'fix b' },
      },
    })
    expect(await screen.findByText('1 lines added, 1 lines removed')).toBeInTheDocument()
    expect(screen.getByText('PRD v1')).toBeInTheDocument()
    expect(screen.getByText('line B')).toBeInTheDocument()
    expect(screen.getByText('fix b')).toBeInTheDocument()
  })

  it('job tools note that the work runs in the background', () => {
    renderCard({ toolCall: { id: 'tc7', name: 'generate_personas', args: { project_id: P, persona_count: 3 } } })
    expect(screen.getByText(/runs in the background/)).toBeInTheDocument()
  })

  it('executes the write once when two cards are mounted for the same interrupt', async () => {
    m.projectsApi.createProject.mockResolvedValue({ success: true, project: { project_id: 'proj_new' } })
    const first = renderCard({ toolCall: createProjectCall })
    const second = renderCard({ toolCall: createProjectCall })
    const approve = screen.getAllByRole('button', { name: 'Approve' })
    await first.user.click(at(approve, 0))
    await second.user.click(at(approve, 1))
    await waitFor(() => expect(first.onResolve).toHaveBeenCalledTimes(1))
    expect(m.projectsApi.createProject).toHaveBeenCalledTimes(1)
    expect(second.onResolve).not.toHaveBeenCalled()
    expect(screen.getAllByText('Done')).toHaveLength(2)
  })

  it('a card remounted while its write is in flight shows executing and cannot approve again', async () => {
    m.projectsApi.createProject.mockReturnValue(new Promise(() => {}))
    const first = renderCard({ toolCall: createProjectCall })
    await first.user.click(screen.getByRole('button', { name: 'Approve' }))
    first.unmount()
    const again = renderCard({ toolCall: createProjectCall })
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    await again.user.click(approve)
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-state', 'executing')
    expect(m.projectsApi.createProject).toHaveBeenCalledTimes(1)
  })

  it('job previews show the time window and response language, and the job runs with exactly those', async () => {
    useConfigStore.setState({ timeRange: '30d', customDays: null })
    m.projectsApi.generatePersonas.mockResolvedValue({ success: true, job_id: 'job_1' })
    const { user, onResolve } = renderCard({ toolCall: { id: 'tc8', name: 'generate_personas', args: { project_id: P, persona_count: 3 } } })
    expect(screen.getByText(/last 30 days/)).toBeInTheDocument()
    expect(screen.getByText(/Writes the result in English/)).toBeInTheDocument()
    useConfigStore.setState({ timeRange: '7d' })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(m.projectsApi.generatePersonas).toHaveBeenCalledWith(P, expect.objectContaining({ days: 30, response_language: 'en' }))
  })

  it('save_brand_settings fails with "review again" when the settings changed after the card showed them', async () => {
    const base = { brand_name: 'Old', brand_handles: [], hashtags: ['#a'], urls_to_track: [] }
    m.api.getBrandSettings.mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, brand_name: 'Changed elsewhere' })
    const { user, onResolve } = renderCard({ toolCall: { id: 'tc9', name: 'save_brand_settings', args: { hashtags: ['#b'] } } })
    expect(await screen.findByText('#b')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({
      outcome: { status: 'failed', error: BRAND_CHANGED_MESSAGE },
    })))
    expect(m.api.saveBrandSettings).not.toHaveBeenCalled()
  })

  it('save_brand_settings saves the merge the card displayed when nothing changed', async () => {
    const base = { brand_name: 'Old', brand_handles: ['@old'], hashtags: ['#a'], urls_to_track: [] }
    m.api.getBrandSettings.mockResolvedValue(base)
    m.api.saveBrandSettings.mockResolvedValue({ success: true })
    const { user, onResolve } = renderCard({ toolCall: { id: 'tc10', name: 'save_brand_settings', args: { hashtags: ['#b'] } } })
    expect(await screen.findByText('#b')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(m.api.saveBrandSettings).toHaveBeenCalledWith({ ...base, hashtags: ['#b'] })
  })
})
