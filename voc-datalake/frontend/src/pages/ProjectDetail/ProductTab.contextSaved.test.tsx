/**
 * @fileoverview The Product tab must tell the page when it saves the context.
 *
 * Found in review of the U8 work, not by the tests: the Overview card reads
 * completeness from a shared query while this tab edits the record in local state.
 * `ProjectDetail` stays mounted across tab switches, so a tab that saved without
 * announcing it left card 1 reporting the count from page load for the rest of the
 * session — the state display looking authoritative while being wrong, which is the
 * defect U8 set out to remove.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import type { ProductContext } from '../../api/types'

const mockGetProductContext = vi.fn()
const mockUpdateProductContext = vi.fn()
const mockListProductDocs = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProductContext: (...args: unknown[]) => mockGetProductContext(...args),
    updateProductContext: (...args: unknown[]) => mockUpdateProductContext(...args),
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    productContextInterview: vi.fn(),
    generateProductReport: vi.fn(),
    getProductDocUploadUrl: vi.fn(),
  },
}))

const context = (fields: Partial<ProductContext> = {}): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

describe('ProductTab onContextSaved', () => {
  // The tab's default mode renders the AI interview, whose effect scrolls the
  // transcript. jsdom has no Element.scrollTo, and the resulting exception renders
  // the whole tab as an empty div — which would turn "the callback was not called"
  // into a vacuous pass. Restored afterwards so the stub cannot leak into another
  // file's expectations.
  const realScrollTo = Element.prototype.scrollTo
  beforeAll(() => {
    Element.prototype.scrollTo = vi.fn()
  })
  afterAll(() => {
    Element.prototype.scrollTo = realScrollTo
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProductContext.mockResolvedValue({ context: context() })
    mockListProductDocs.mockResolvedValue({ docs: [] })
  })

  it('hands the saved context back after a field is edited', async () => {
    const user = userEvent.setup()
    const saved = context({ product_name: 'VoC' })
    mockUpdateProductContext.mockResolvedValue({ context: saved })
    const onContextSaved = vi.fn()

    render(<ProductTab projectId="proj-1" onContextSaved={onContextSaved} />)

    const field = await screen.findByLabelText(/product name/i)
    await user.type(field, 'VoC')
    await user.tab()

    await waitFor(() => {
      expect(onContextSaved).toHaveBeenCalled()
    })
    // The server's copy, normalised — the Overview derives a field count from it,
    // so a partial object would undercount.
    expect(onContextSaved).toHaveBeenLastCalledWith(
      expect.objectContaining({
        product_name: 'VoC',
        free_form_notes: '',
      }),
    )
  })

  it('does not announce a save that failed', async () => {
    const user = userEvent.setup()
    mockUpdateProductContext.mockRejectedValue(new Error('API Error: 500'))
    const onContextSaved = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<ProductTab projectId="proj-1" onContextSaved={onContextSaved} />)

    const field = await screen.findByLabelText(/product name/i)
    await user.type(field, 'VoC')
    await user.tab()

    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalled()
    })
    expect(onContextSaved).not.toHaveBeenCalled()
  })

  it('works without the callback, since it is optional', async () => {
    const user = userEvent.setup()
    mockUpdateProductContext.mockResolvedValue({ context: context({ product_name: 'VoC' }) })

    render(<ProductTab projectId="proj-1" />)

    const field = await screen.findByLabelText(/product name/i)
    await user.type(field, 'VoC')
    await user.tab()

    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalled()
    })
  })
})
