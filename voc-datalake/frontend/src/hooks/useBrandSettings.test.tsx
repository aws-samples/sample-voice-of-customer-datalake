/**
 * The sidebar's brand comes from the shell, on every page (E2E F12).
 *
 * It used to read only the persisted config store, which nothing filled until
 * the admin page loaded the brand — so the subtitle said "Configure brand" and
 * then flipped to the brand once /admin had been visited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

const mockGetBrandSettings = vi.fn<() => Promise<unknown>>()
vi.mock('../api/client', () => ({ api: { getBrandSettings: () => mockGetBrandSettings() } }))

import { useBrandName } from './useBrandSettings'
import { useConfigStore } from '../store/configStore'
import { Sidebar } from '../components/Layout/SidebarComponents'

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const API = 'https://api.example.com'

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState((state) => ({ config: { ...state.config, brandName: '' } }))
})

describe('useBrandName', () => {
  it('reads the stored brand without the admin page, and remembers it', async () => {
    mockGetBrandSettings.mockResolvedValue({ brand_name: 'Voice of Customer', brand_handles: [] })

    const { result } = renderHook(() => useBrandName(API), { wrapper })

    await waitFor(() => expect(result.current.brandName).toBe('Voice of Customer'))
    expect(useConfigStore.getState().config.brandName).toBe('Voice of Customer')
  })

  it('shows the persisted name while the request is in flight', () => {
    useConfigStore.setState((state) => ({ config: { ...state.config, brandName: 'Cached Brand' } }))
    mockGetBrandSettings.mockReturnValue(new Promise(() => undefined))

    const { result } = renderHook(() => useBrandName(API), { wrapper })

    expect(result.current).toStrictEqual({ brandName: 'Cached Brand', isLoading: true })
  })

  it('keeps the persisted name when the API answers an error payload', async () => {
    useConfigStore.setState((state) => ({ config: { ...state.config, brandName: 'Cached Brand' } }))
    mockGetBrandSettings.mockResolvedValue({ error: 'boom' })

    const { result } = renderHook(() => useBrandName(API), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.brandName).toBe('Cached Brand')
  })
})

function renderSidebar(brandName: string, brandLoading: boolean) {
  render(
    <MemoryRouter>
      <Sidebar
        sidebarCollapsed={false} mobileMenuOpen={false} brandName={brandName} brandLoading={brandLoading}
        visibleNavItems={[]} urgentCount={0} isAuthenticated user={null}
        onClose={vi.fn()} onToggleCollapse={vi.fn()} onLogout={vi.fn()}
      />
    </MemoryRouter>,
  )
}

describe('sidebar brand subtitle', () => {
  it('never says "Configure brand" while the brand is still loading', () => {
    renderSidebar('', true)
    expect(screen.queryByText('Configure brand')).not.toBeInTheDocument()
  })

  it('says "Configure brand" once the brand is known to be unset', () => {
    renderSidebar('', false)
    expect(screen.getByText('Configure brand')).toBeInTheDocument()
  })

  it('shows the brand', () => {
    renderSidebar('Voice of Customer', false)
    expect(screen.getByText('Voice of Customer')).toBeInTheDocument()
  })
})
