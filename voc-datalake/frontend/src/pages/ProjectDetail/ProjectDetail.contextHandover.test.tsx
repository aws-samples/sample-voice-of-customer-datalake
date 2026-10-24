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
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PAGE_PROJECT } from './project-detail-fixtures'
import { projectDataApiModule, projectDataMocks } from './project-data-fixtures'
import { renderProjectDetailPage } from './project-detail-page-fixtures'
import { emptyProductContext } from './productContextFields'
import { stubScrollToForSuite } from './project-detail-fixtures'
import { useConfigStore } from '../../store/configStore'
import type { ProductContext } from '../../api/projectTypes'

const {
  getProject: mockGetProject, getJobs: mockGetJobs, getProductContext: mockGetProductContext,
} = projectDataMocks
const mockUpdateProductContext = vi.fn<(...args: unknown[]) => unknown>()
const mockListProductDocs = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    ...projectDataApiModule().projectsApi,
    updateProductContext: (...args: unknown[]) => mockUpdateProductContext(...args),
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    dismissJob: vi.fn(),
    updateProject: vi.fn(),
    productContextInterview: vi.fn(),
    generateProductReport: vi.fn(),
    getProductDocUploadUrl: vi.fn(),
  },
}))

const project = PAGE_PROJECT

const context = (fields: Partial<ProductContext> = {}): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

const renderPage = renderProjectDetailPage

describe('ProjectDetail product-context handover', () => {
  // jsdom has no Element.scrollTo; see stubScrollToForSuite for why that matters here.
  stubScrollToForSuite()

  beforeEach(() => {
    vi.clearAllMocks()
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, apiEndpoint: 'https://api.example.com/v1' } })
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

    await user.click(screen.getByRole('tab', { name: /product/i }))
    const field = await screen.findByLabelText(/product name/i)
    await user.type(field, 'Reader')
    await user.tab()
    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalledWith('proj-1', { product_name: 'Reader' })
    })

    // Two reads by this point, and that is the known cost: this page fetches the
    // context for the card, and the Product tab fetches it again because it owns
    // the record while editing.
    const readsBeforeReturning = mockGetProductContext.mock.calls.length

    await user.click(screen.getByRole('tab', { name: /overview/i }))

    expect(await screen.findByText('1 of 11 fields filled')).toBeInTheDocument()
    // From the cache the save seeded, not from a third request — which is what
    // makes "hand the value back" different from "invalidate and refetch".
    expect({
      staleCard: screen.queryByText('Not described yet') !== null,
      reads: mockGetProductContext.mock.calls.length,
    }).toStrictEqual({ staleCard: false, reads: readsBeforeReturning })
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
