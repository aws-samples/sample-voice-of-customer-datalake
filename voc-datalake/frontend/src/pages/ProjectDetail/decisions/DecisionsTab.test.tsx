import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/test-utils'
import DecisionsTab from './DecisionsTab'
import type { ProjectDocument } from '../../../api/types'

const api = vi.hoisted(() => ({
  createDecision: vi.fn(),
  updateDecision: vi.fn(),
  pursueDecision: vi.fn(),
}))
vi.mock('../../../api/decisionsApi', () => ({ decisionsApi: api }))
vi.mock('../../../api/releaseWatchApi', () => ({
  releaseWatchApi: { getReleaseWatch: vi.fn().mockResolvedValue({ windowDays: 14, releases: [], partial: { isPartial: false, scannedThrough: null } }) },
}))

const PRD: ProjectDocument = { document_id: 'prd_1', document_type: 'prd', title: 'Checkout PRD', content: '', created_at: '' }
// A decision document as GET /projects/{id} returns it (extra wire fields ride along).
const DECISION = Object.assign(
  { document_id: 'doc_1', document_type: 'decision', title: 'Offline mode', content: '# Offline mode', created_at: '2026-10-01' },
  { revision: 2, decision: {
    verdict: 'pursue', rationale: 'Top complaint', success_metric: 'Complaints -50 %', kill_criterion: '',
    evidence: { feedback_ids: ['fb_1'], document_ids: ['prd_1'] }, review_by: null, launched_at: '2026-10-05',
    decided_by: 'sub-user', decided_by_name: 'Ana', decided_at: '2026-10-02T00:00:00Z',
  } },
)

const renderTab = ({ canEdit = true, entry = '/projects/p1?tab=decisions', documents = [PRD, DECISION] } = {}) => {
  const onJobStarted = vi.fn()
  render(<DecisionsTab projectId="p1" documents={documents} canEdit={canEdit} onJobStarted={onJobStarted} />, { initialEntries: [entry] })
  return { user: userEvent.setup(), onJobStarted }
}

beforeEach(() => {
  api.createDecision.mockReset().mockResolvedValue(null)
  api.updateDecision.mockReset().mockResolvedValue(null)
  api.pursueDecision.mockReset().mockResolvedValue('job-1')
})

describe('DecisionsTab', () => {
  it('lists a decision with its verdict, measures and evidence', () => {
    renderTab()
    const card = screen.getByRole('article', { name: 'Offline mode' })
    expect(card).toHaveTextContent('Pursue')
    expect(card).toHaveTextContent('Decided by Ana on 2026-10-02')
    expect(screen.getByRole('link', { name: 'Review 1' })).toHaveAttribute('href', '/projects/p1?tab=decisions&review=fb_1')
  })

  it('creates a decision from the form', async () => {
    const { user } = renderTab({ documents: [PRD] })
    await user.click(screen.getByRole('button', { name: 'New decision' }))
    await user.type(screen.getByLabelText('Title'), 'Dark mode')
    await user.click(screen.getByLabelText('Park'))
    await user.type(screen.getByLabelText('Rationale'), 'Few asks')
    await user.click(screen.getByRole('checkbox', { name: 'Checkout PRD' }))
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(api.createDecision).toHaveBeenCalledTimes(1))
    expect(api.createDecision.mock.calls[0]?.[1]).toMatchObject({
      title: 'Dark mode', verdict: 'park', rationale: 'Few asks', evidence: { feedback_ids: [], document_ids: ['prd_1'] },
    })
  })

  it('edits with the revision it loaded', async () => {
    const { user } = renderTab()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(api.updateDecision).toHaveBeenCalledTimes(1))
    expect(api.updateDecision.mock.calls[0]?.slice(1, 2)).toStrictEqual(['doc_1'])
    expect(api.updateDecision.mock.calls[0]?.[3]).toBe(2)
  })

  it('"Draft PR/FAQ" asks first, then seeds the PR/FAQ chain and hands the job to the jobs panel', async () => {
    const { user, onJobStarted } = renderTab()
    await user.click(screen.getByRole('button', { name: 'Draft PR/FAQ' }))
    expect(api.pursueDecision).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Draft PR/FAQ' }))
    await waitFor(() => expect(onJobStarted).toHaveBeenCalledTimes(1))
    expect(api.pursueDecision).toHaveBeenCalledWith('p1', 'doc_1', 'en')
  })

  it('cancelling the "Draft PR/FAQ" question starts nothing', async () => {
    const { user } = renderTab()
    await user.click(screen.getByRole('button', { name: 'Draft PR/FAQ' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(/takes a few minutes/)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.pursueDecision).not.toHaveBeenCalled()
  })

  it('opens the editor prefilled from a deep link', () => {
    renderTab({ entry: '/projects/p1?tab=decisions&newDecision=1&title=From%20a%20card&verdict=reject&feedback=fb_7,fb_8' })
    expect(screen.getByLabelText('Title')).toHaveValue('From a card')
    expect(screen.getByLabelText('Reject')).toBeChecked()
    expect(screen.getByLabelText('Feedback ids')).toHaveValue('fb_7 fb_8')
  })

  it('a viewer sees decisions but no write controls, and a deep link opens nothing', () => {
    renderTab({ canEdit: false, entry: '/projects/p1?tab=decisions&newDecision=1&title=x' })
    expect(screen.getByRole('article', { name: 'Offline mode' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New decision|Edit|Draft PR\/FAQ/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('a launched decision can show its release watch', async () => {
    const { user } = renderTab()
    await user.click(screen.getByRole('button', { name: 'Release watch' }))
    expect(await screen.findByText('No release in this period.')).toBeInTheDocument()
  })

  it('says so when there are no decisions', () => {
    renderTab({ documents: [PRD] })
    expect(screen.getByText(/No decisions yet/)).toBeInTheDocument()
  })
})
