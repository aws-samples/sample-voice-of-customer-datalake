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
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { productTabApiModule, productTabMocks } from './product-tab-fixtures'
// After the fixtures on purpose: this imports ProductTab, whose module graph runs
// the `vi.mock` factory below, which needs the fixture module evaluated.
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import { stubScrollToForSuite } from './project-detail-fixtures'
import type { ProductContext } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => productTabApiModule())
const {
  getProductContext: mockGetProductContext,
  updateProductContext: mockUpdateProductContext,
  listProductDocs: mockListProductDocs,
} = productTabMocks

const context = (fields: Partial<ProductContext> = {}): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

describe('ProductTab onContextSaved', () => {
  // jsdom has no Element.scrollTo; see stubScrollToForSuite for why that matters here.
  stubScrollToForSuite()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProductContext.mockResolvedValue({ context: context() })
    mockListProductDocs.mockResolvedValue({ docs: [] })
  })

  it('hands the saved context back after a field is edited', async () => {
    const saved = context({ product_name: 'VoC' })
    mockUpdateProductContext.mockResolvedValue({ context: saved })
    const onContextSaved = vi.fn()

    await editProductName(onContextSaved)

    await waitFor(() => {
      expect(onContextSaved).toHaveBeenCalledWith(saved)
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
    mockUpdateProductContext.mockRejectedValue(new Error('API Error: 500'))
    const onContextSaved = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await editProductName(onContextSaved)

    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalledWith('proj-1', { product_name: 'VoC' })
    })
    expect(onContextSaved).not.toHaveBeenCalled()
  })

  it('works without the callback, since it is optional', async () => {
    mockUpdateProductContext.mockResolvedValue({ context: context({ product_name: 'VoC' }) })

    await editProductName(undefined)

    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalledWith('proj-1', { product_name: 'VoC' })
    })
  })
})

/** Renders the tab, types a product name and blurs the field, which is what triggers a save. */
async function editProductName(onContextSaved: ((context: ProductContext) => void) | undefined) {
  const user = userEvent.setup()
  render(<ProductTab canEdit projectId="proj-1" onContextSaved={onContextSaved} />)

  const field = await screen.findByLabelText(/product name/i)
  await user.type(field, 'VoC')
  await user.tab()
}
