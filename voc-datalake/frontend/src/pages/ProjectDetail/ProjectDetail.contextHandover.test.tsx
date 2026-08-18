/**
 * U8: the Overview card's completeness must survive an edit made in the Product tab.
 *
 * The bug was a wiring gap between two owners of the same record — the Product tab
 * edits it in local state, the Overview card reads it from a shared query — and
 * `ProjectDetail` stays mounted across tab switches, so the card kept reporting the
 * count from page load.
 *
 * `ProductTab.contextSaved.test.tsx` proves the tab calls its callback. That is not
 * the same thing: the defect was that nothing consumed it. This drives the real
 * seam — edit in one tab, read in another — so it fails if the callback is left
 * unwired even while the component-level tests stay green.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProjectDetail from './ProjectDetail'
import { emptyProductContext } from './productContextFields'
import { stubElementScrollTo } from '../../test/stubScrollTo'
import { useConfigStore } from '../../store/configStore'
import type { Project, ProductContext } from '../../api/types'

const mockGetProject = vi.fn()
const mockGetJobs = vi.fn()
const mockGetProductContext = vi.fn()
const mockUpdateProductContext = vi.fn()
const mockListProductDocs = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProject: (...args: unknown[]) => mockGetProject(...args),
    getJobs: (...args: unknown[]) => mockGetJobs(...args),
    getProductContext: (...args: unknown[]) => mockGetProductContext(...args),
    updateProductContext: (...args: unknown[]) => mockUpdateProductContext(...args),
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
    productContextInterview: vi.fn(),
    generateProductReport: vi.fn(),
    getProductDocUploadUrl: vi.fn(),
  },
}))

const project: Project = {
  project_id: 'proj-1',
  name: 'Reader Engagement',
  description: '',
  status: 'active',
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  persona_count: 0,
  document_count: 0,
}

const context = (fields: Partial<ProductContext> = {}): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/proj-1']}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ProjectDetail product-context handover', () => {
  // The Product tab renders the AI interview, whose effect scrolls the transcript;
  // jsdom has no Element.scrollTo and the exception would blank the tab.
  let restoreScrollTo: () => void
  beforeAll(() => {
    restoreScrollTo = stubElementScrollTo()
  })
  afterAll(() => {
    restoreScrollTo()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useConfigStore.setState({ config: { apiEndpoint: 'https://api.example.com/v1' } })
    mockGetProject.mockResolvedValue({
      project,
      personas: [],
      documents: [],
    })
    mockGetJobs.mockResolvedValue({ jobs: [] })
    mockGetProductContext.mockResolvedValue({ context: context() })
    mockListProductDocs.mockResolvedValue({ docs: [] })
  })

  it('updates the Overview card after a field is saved in the Product tab', async () => {
    const user = userEvent.setup()
    mockUpdateProductContext.mockResolvedValue({ context: context({ product_name: 'Reader' }) })

    renderPage()

    // Overview, before: nothing described.
    expect(await screen.findByText('Not described yet')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /product/i }))
    const field = await screen.findByLabelText(/product name/i)
    await user.type(field, 'Reader')
    await user.tab()
    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalled()
    })

    // Two reads by this point, and that is the known cost: this page fetches the
    // context for the card, and the Product tab fetches it again because it owns
    // the record while editing.
    const readsBeforeReturning = mockGetProductContext.mock.calls.length

    await user.click(screen.getByRole('button', { name: /overview/i }))

    expect(await screen.findByText('1 of 11 fields filled')).toBeInTheDocument()
    expect(screen.queryByText('Not described yet')).not.toBeInTheDocument()
    // From the cache the save seeded, not from a third request — which is what
    // makes "hand the value back" different from "invalidate and refetch".
    expect(mockGetProductContext).toHaveBeenCalledTimes(readsBeforeReturning)
  })

  it('leaves the card showing no state when the context request fails', async () => {
    // The card is built to tolerate not knowing: unknown renders nothing rather
    // than claiming the description is empty.
    mockGetProductContext.mockRejectedValue(new Error('API Error: 500'))

    renderPage()

    expect(await screen.findByText('Product / Service Description')).toBeInTheDocument()
    expect(screen.queryByText('Not described yet')).not.toBeInTheDocument()
    expect(screen.queryByText(/fields filled/)).not.toBeInTheDocument()
  })
})
