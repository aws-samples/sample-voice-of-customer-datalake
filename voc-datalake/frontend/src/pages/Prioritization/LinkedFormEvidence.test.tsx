/**
 * Tests for the collected-feedback panel on a prioritization row.
 *
 * These drive the whole page rather than the panel in isolation, because two of
 * the behaviours under test are properties of the page: which form matches which
 * row, and that no stats request is made until a row is expanded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'

const mockGetProjects = vi.fn()
const mockGetProject = vi.fn()
const mockGetPrioritizationScores = vi.fn()
const mockGetFeedbackForms = vi.fn()
const mockGetFeedbackFormStats = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: () => mockGetProjects(),
    getProject: (id: string) => mockGetProject(id),
  },
}))

vi.mock('../../api/client', () => ({
  api: {
    getPrioritizationScores: () => mockGetPrioritizationScores(),
    patchPrioritizationScores: () => Promise.resolve({ success: true }),
    getFeedbackForms: () => mockGetFeedbackForms(),
    getFeedbackFormStats: (formId: string) => mockGetFeedbackFormStats(formId),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }),
}))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))

import Prioritization from './Prioritization'

const project = {
  project_id: 'p1', name: 'Project 1', status: 'active',
  created_at: '2025-01-01', updated_at: '2025-01-01', persona_count: 0, document_count: 2,
}

const prfaq = {
  document_id: 'doc_prfaq', document_type: 'prfaq', title: 'Feature A PR/FAQ',
  content: '# Feature A', created_at: '2025-01-01',
}
const prd = {
  document_id: 'doc_prd', document_type: 'prd', title: 'Feature A PRD',
  content: 'PRD content', created_at: '2025-01-02',
}

const { t } = i18n

function renderPrioritization() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', element: <Prioritization /> }])
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Render the page and open one row — the panel is expand-only by design. */
async function expandRow(title: string) {
  const user = userEvent.setup()
  renderPrioritization()
  await waitFor(() => {
    expect(screen.getByText(title)).toBeInTheDocument()
  })
  await user.click(screen.getByText(title))
}

/**
 * The value rendered next to an evidence metric's label. Reads the sibling of
 * the label node, so the assertion is about that metric rather than about any
 * text anywhere on the page.
 */
function readMetricValue(label: string): string | null {
  const labelNode = screen.getByText(label)
  return labelNode.parentElement?.firstElementChild?.textContent ?? null
}

/** How assistive technology names the QR of one form — the QR carries no text. */
function qrName(formName: string): string {
  return t('components:formQrCode.accessibleName', { formName })
}

describe('collected feedback on a prioritization row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProjects.mockResolvedValue({ projects: [project] })
    mockGetProject.mockResolvedValue({ project_id: 'p1', documents: [prfaq, prd] })
    mockGetPrioritizationScores.mockResolvedValue({ scores: {} })
    mockGetFeedbackForms.mockResolvedValue({ forms: [] })
    mockGetFeedbackFormStats.mockResolvedValue({
      success: true, form_id: 'form_1',
      stats: { total_submissions: 12, avg_rating: 3.2, rating_count: 10 },
    })
  })

  it('shows the submission count and average rating of the form linked to the row', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_1', name: 'PR/FAQ concept test', project_id: 'p1', document_id: 'doc_prfaq' }],
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText('PR/FAQ concept test')).toBeInTheDocument()
    })
    // The end state the change exists for: "12 submissions, average 3.2" on the
    // row being scored.
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('3.2')).toBeInTheDocument()
    expect(mockGetFeedbackFormStats).toHaveBeenCalledWith('form_1')
  })

  it('says so when no form is linked to the row', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      // A standalone website survey: linked to nothing, so it belongs to no row.
      forms: [{ form_id: 'form_9', name: 'Website Footer Form' }],
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:evidence.noLinkedForm'))).toBeInTheDocument()
    })
    expect(screen.queryByText('Website Footer Form')).not.toBeInTheDocument()
    // And no money is spent on stats for a row with nothing to show.
    expect(mockGetFeedbackFormStats).not.toHaveBeenCalled()
  })

  it('renders a null average as no ratings, never as zero', async () => {
    // What a ratings-disabled form actually returns: submissions but no average.
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_1', name: 'Text-only form', project_id: 'p1', document_id: 'doc_prfaq' }],
    })
    mockGetFeedbackFormStats.mockResolvedValue({
      success: true, form_id: 'form_1',
      stats: { total_submissions: 7, avg_rating: null, rating_count: 0 },
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:evidence.noRatings'))).toBeInTheDocument()
    })
    expect(screen.getByText('7')).toBeInTheDocument()
    // A 0 or 0.0 here would read as unanimously terrible feedback. Read the
    // rendered value out of the average metric itself rather than searching the
    // page, which also contains the "0 High Priority" stats cards.
    expect(readMetricValue(t('prioritization:evidence.avgRating'))).toBe('—')
  })

  it('shows every form validating the same document', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [
        { form_id: 'form_1', name: 'Concept test', project_id: 'p1', document_id: 'doc_prfaq' },
        { form_id: 'form_2', name: 'Pricing test', project_id: 'p1', document_id: 'doc_prfaq' },
      ],
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText('Concept test')).toBeInTheDocument()
    })
    expect(screen.getByText('Pricing test')).toBeInTheDocument()
  })

  it('still shows a project\'s evidence after its document was regenerated', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      // doc_v1 no longer exists — regenerating minted doc_prfaq.
      forms: [{ form_id: 'form_1', name: 'Concept test', project_id: 'p1', document_id: 'doc_v1' }],
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText('Concept test')).toBeInTheDocument()
    })
    expect(screen.getByText('3.2')).toBeInTheDocument()
  })

  it('degrades gracefully when a linked form no longer exists', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_gone', name: 'Deleted form', project_id: 'p1', document_id: 'doc_prfaq' }],
    })
    mockGetFeedbackFormStats.mockRejectedValue(new Error('Form not found'))

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:evidence.unavailable'))).toBeInTheDocument()
    })
  })

  it('fetches stats only for the row that is expanded', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [
        { form_id: 'form_1', name: 'PR/FAQ form', project_id: 'p1', document_id: 'doc_prfaq' },
        { form_id: 'form_2', name: 'PRD form', project_id: 'p1', document_id: 'doc_prd' },
      ],
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(mockGetFeedbackFormStats).toHaveBeenCalledWith('form_1')
    })
    // The stats endpoint scans a whole brand-wide partition per call, so a page
    // of rows must not fan out on load.
    expect(mockGetFeedbackFormStats).not.toHaveBeenCalledWith('form_2')
  })

  it('makes no stats request at all until a row is expanded', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_1', name: 'PR/FAQ form', project_id: 'p1', document_id: 'doc_prfaq' }],
    })

    renderPrioritization()

    await waitFor(() => {
      expect(screen.getByText('Feature A PR/FAQ')).toBeInTheDocument()
    })
    expect(mockGetFeedbackFormStats).not.toHaveBeenCalled()
  })

  it('keeps the QR out of the row until it is asked for', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_1', name: 'PR/FAQ concept test', project_id: 'p1', document_id: 'doc_prfaq' }],
    })

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText('PR/FAQ concept test')).toBeInTheDocument()
    })
    // A QR needs ~200px to scan, and a pitch discusses one artifact at a time —
    // the row's resting state stays the count and the average it shipped with.
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('3.2')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: qrName('PR/FAQ concept test') })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a scannable QR for the linked form, and closes it again', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_1', name: 'PR/FAQ concept test', project_id: 'p1', document_id: 'doc_prfaq' }],
    })
    const user = userEvent.setup()

    await expandRow('Feature A PR/FAQ')
    await waitFor(() => {
      expect(screen.getByText('PR/FAQ concept test')).toBeInTheDocument()
    })
    // A button, so it is reachable and operable from the keyboard.
    await user.click(screen.getByRole('button', { name: t('prioritization:qr.show') }))

    const dialog = screen.getByRole('dialog')
    // Named, not an anonymous overlay — and the QR inside it names its form.
    expect(dialog).toHaveAccessibleName(t('prioritization:qr.title'))
    expect(screen.getByRole('img', { name: qrName('PR/FAQ concept test') })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('spends no extra request on the QR beyond what the row already fetched', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_1', name: 'PR/FAQ concept test', project_id: 'p1', document_id: 'doc_prfaq' }],
    })
    const user = userEvent.setup()

    await expandRow('Feature A PR/FAQ')
    await waitFor(() => {
      expect(mockGetFeedbackFormStats).toHaveBeenCalledTimes(1)
    })
    const formsListCalls = mockGetFeedbackForms.mock.calls.length

    await user.click(screen.getByRole('button', { name: t('prioritization:qr.show') }))

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
    // The row already holds the form object; the QR is derived from its id. A
    // fetch here would be paid on a page that is already N+1 on project reads.
    expect(mockGetFeedbackFormStats).toHaveBeenCalledTimes(1)
    expect(mockGetFeedbackForms.mock.calls.length).toBe(formsListCalls)
  })

  it('withholds the QR when the linked form no longer exists', async () => {
    mockGetFeedbackForms.mockResolvedValue({
      forms: [{ form_id: 'form_gone', name: 'Deleted form', project_id: 'p1', document_id: 'doc_prfaq' }],
    })
    mockGetFeedbackFormStats.mockRejectedValue(new Error('Form not found'))

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:evidence.unavailable'))).toBeInTheDocument()
    })
    // Its public page is gone too, so a QR would send the room to a 404.
    expect(screen.queryByRole('button', { name: t('prioritization:qr.show') })).not.toBeInTheDocument()
  })

  it('renders the row when the forms list request fails', async () => {
    // Evidence is a nice-to-have; scoring must not become impossible without it.
    mockGetFeedbackForms.mockRejectedValue(new Error('boom'))

    await expandRow('Feature A PR/FAQ')

    await waitFor(() => {
      expect(screen.getByText(t('prioritization:scores.title'))).toBeInTheDocument()
    })
    expect(screen.getByText(t('prioritization:evidence.noLinkedForm'))).toBeInTheDocument()
  })
})
