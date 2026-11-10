/**
 * @fileoverview The Product tab saves each field on its own and keeps the shared
 * product-context query current.
 *
 * The Overview card counts completeness from that query and `ProjectDetail` stays
 * mounted across tab switches, so a save that left the cache alone would leave the
 * card reporting the count from page load. And the assistant's approved
 * `update_product_context` refreshes the same query — the form must show what the
 * assistant filled in without a reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { companyStripModule, productTabApiModule, productTabMocks } from './product-tab-fixtures'
// After the fixtures on purpose: this imports ProductTab, whose module graph runs
// the `vi.mock` factory below, which needs the fixture module evaluated.
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import { productContextKey } from './useProjectData'
import type { QueryClient } from '@tanstack/react-query'
import type { ProductContext } from '../../api/projectTypes'

vi.mock('../../api/projectsApi', () => productTabApiModule())
vi.mock('./CompanyContextStrip', () => companyStripModule())
const {
  getProductContext: mockGetProductContext,
  updateProductContext: mockUpdateProductContext,
  listProductDocs: mockListProductDocs,
} = productTabMocks

const context = (fields: Partial<ProductContext> = {}): ProductContext => ({
  ...emptyProductContext(),
  ...fields,
})

const cached = (client: QueryClient) => client.getQueryData(productContextKey('proj-1'))

describe('ProductTab saving', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProductContext.mockResolvedValue({ context: context() })
    mockListProductDocs.mockResolvedValue({ docs: [] })
  })

  it('saves one field on blur and seeds the shared query with the server copy', async () => {
    const client = createTestQueryClient({ gcTime: Infinity })
    mockUpdateProductContext.mockResolvedValue({ context: { product_name: 'VoC' } })

    await editProductName(client)

    await waitFor(() => {
      expect(cached(client)).toStrictEqual({ context: context({ product_name: 'VoC' }) })
    })
    expect(mockUpdateProductContext).toHaveBeenCalledExactlyOnceWith('proj-1', { product_name: 'VoC' })
  })

  it('keeps the cached context when the save fails', async () => {
    const client = createTestQueryClient({ gcTime: Infinity })
    mockUpdateProductContext.mockRejectedValue(new Error('API Error: 500'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await editProductName(client)

    await waitFor(() => {
      expect(mockUpdateProductContext).toHaveBeenCalledWith('proj-1', { product_name: 'VoC' })
    })
    expect(cached(client)).toStrictEqual({ context: context() })
  })

  it('shows what an approved assistant card wrote to the shared query, without a reload', async () => {
    const client = createTestQueryClient({ gcTime: Infinity })
    renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />, client)
    expect(await screen.findByLabelText(/target users/i)).toHaveValue('')

    act(() => {
      client.setQueryData(productContextKey('proj-1'), { context: context({ target_users: 'Commuters' }) })
    })

    await waitFor(() => expect(screen.getByLabelText(/target users/i)).toHaveValue('Commuters'))
    expect(mockGetProductContext).toHaveBeenCalledExactlyOnceWith('proj-1')
  })
})

/** Renders the tab, types a product name and blurs the field, which is what triggers a save. */
async function editProductName(client: QueryClient) {
  const user = userEvent.setup()
  renderWithQueryClient(<ProductTab canEdit projectId="proj-1" />, client)

  const field = await screen.findByLabelText(/product name/i)
  await user.type(field, 'VoC')
  await user.tab()
}
