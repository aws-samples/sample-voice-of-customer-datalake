/**
 * Settings → Users → Category access: loads the stored grant (no row = all),
 * saves ['*'] or the selected names, and states the admin/owner rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { primeCategoryClient } from '@test/categoryClientMock'

const client = await vi.hoisted(async () =>
  (await import('@test/categoryClientMock')).createCategoryClientMock())
vi.mock('../../api/client', () => client.module)

import CategoryAccessModal from './CategoryAccessModal'
import type { CognitoUser } from '../../api/types'

const viewer: CognitoUser = {
  username: 'viewer-demo', email: 'viewer@example.com', name: 'Vic', status: 'CONFIRMED', enabled: true,
  groups: ['users'], created_at: null, last_modified: null,
}

function renderModal(user: CognitoUser = viewer, onSaved = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><CategoryAccessModal user={user} onClose={vi.fn()} onSaved={onSaved} /></QueryClientProvider>)
  return { onSaved }
}

beforeEach(() => {
  primeCategoryClient(client, {
    categories: [
      { id: 'cat_delivery', name: 'delivery', description: 'Delivery', product: 'Fulfilment', subcategories: [] },
      { id: 'cat_pricing', name: 'pricing', description: 'Pricing', subcategories: [] },
    ],
  })
  client.fetchApi.mockImplementation((_endpoint: string, options?: { method?: string; body?: string }) =>
    Promise.resolve(options?.method === 'PUT' ? JSON.parse(options.body ?? '{}') : { username: 'viewer-demo' }))
})

describe('CategoryAccessModal', () => {
  it('reads no stored row as all categories', async () => {
    renderModal()
    expect(await screen.findByRole('radio', { name: 'All categories' })).toBeChecked()
    expect(screen.getByText(/Product owners always see their own categories/)).toBeInTheDocument()
  })

  it('saves the selected categories', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderModal()
    await user.click(await screen.findByRole('radio', { name: 'Only selected categories' }))
    await user.click(await screen.findByRole('checkbox', { name: /Delivery/ }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(client.fetchApi).toHaveBeenCalledWith('/users/viewer-demo/category-access', {
      method: 'PUT', body: JSON.stringify({ categories: ['delivery'], sources: null }),
    }))
    expect(onSaved).toHaveBeenCalledWith('viewer@example.com')
  })

  it('refuses an empty selection', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(await screen.findByRole('radio', { name: 'Only selected categories' }))
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  })

  it('tells the admin that admins always see everything', async () => {
    renderModal({ ...viewer, groups: ['admins'] })
    expect(await screen.findByText(/always sees every category/)).toBeInTheDocument()
  })
})
