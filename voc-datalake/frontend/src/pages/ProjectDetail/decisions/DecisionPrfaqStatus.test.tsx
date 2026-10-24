/**
 * @fileoverview A decision's "Draft PR/FAQ" note follows its job: "requested"
 * while the job runs, a link to the PR/FAQ once it exists, a failure line when
 * the job failed, and nothing when the job is gone — the "appears when the job
 * finishes" note never outlives the job (production sweep).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { render } from '../../../test/test-utils'
import DecisionsTab from './DecisionsTab'
import type { ProjectDocument } from '../../../api/types'

const projects = vi.hoisted(() => ({ getJobs: vi.fn() }))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: projects }))
vi.mock('../../../api/decisionsApi', () => ({ decisionsApi: { createDecision: vi.fn(), updateDecision: vi.fn(), pursueDecision: vi.fn() } }))

const PRFAQ: ProjectDocument = { document_id: 'prfaq_1', document_type: 'prfaq', title: 'Offline mode PR/FAQ', content: '', created_at: '' }
const DECISION = Object.assign(
  { document_id: 'doc_1', document_type: 'decision', title: 'Offline mode', content: '', created_at: '2026-10-01' },
  { revision: 1, seeded_prfaq_job_id: 'job_1', decision: {
    verdict: 'pursue', rationale: 'Top complaint', success_metric: '', kill_criterion: '',
    evidence: { feedback_ids: [], document_ids: [] }, review_by: null, launched_at: null,
    decided_by: 'sub-user', decided_by_name: '', decided_at: '2026-10-02T00:00:00Z',
  } },
)
const REQUESTED = /A PR\/FAQ was requested from this decision/

const job = (status: string, result: Record<string, unknown> = {}) => ({ job_id: 'job_1', job_type: 'generate_prfaq', status, result })

function renderWithJobs(jobs: unknown[], documents: ProjectDocument[] = [DECISION]) {
  projects.getJobs.mockResolvedValue({ success: true, jobs })
  render(<DecisionsTab projectId="p1" documents={documents} canEdit />, { initialEntries: ['/projects/p1?tab=decisions'] })
}

beforeEach(() => { projects.getJobs.mockReset() })

describe('Decision → PR/FAQ status', () => {
  it('says the PR/FAQ was requested while its job runs', async () => {
    renderWithJobs([job('running')])
    expect(await screen.findByText(REQUESTED)).toBeInTheDocument()
    expect(projects.getJobs).toHaveBeenCalledWith('p1')
  })

  it('links that PR/FAQ itself, and drops the "requested" note, once the job made it', async () => {
    renderWithJobs([job('completed', { document_id: 'prfaq_1' })], [DECISION, PRFAQ])
    const link = await screen.findByRole('link', { name: 'PR/FAQ ready: Offline mode PR/FAQ' })
    expect(link).toHaveAttribute('href', '/projects/p1?tab=documents&doc=prfaq_1')
    expect(screen.queryByText(REQUESTED)).not.toBeInTheDocument()
  })

  it('says the job failed instead of promising a document', async () => {
    renderWithJobs([job('failed')])
    expect(await screen.findByText(/could not be generated/)).toBeInTheDocument()
    expect(screen.queryByText(REQUESTED)).not.toBeInTheDocument()
  })

  it('shows nothing when the job is no longer in the jobs list', async () => {
    renderWithJobs([{ job_id: 'other', status: 'running' }, 'not a job'])
    await waitFor(() => expect(projects.getJobs).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('article', { name: 'Offline mode' })).not.toHaveTextContent(/PR\/FAQ (was requested|ready)/)
  })
})
