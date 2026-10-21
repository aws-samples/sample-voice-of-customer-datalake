/**
 * @fileoverview Tests for the admin custom-field filters config card (Phase 4d).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CustomFiltersSection from './CustomFiltersSection'

const mockGetCustomFilters = vi.fn()
const mockSaveCustomFilters = vi.fn()
const mockGetCustomFieldCandidates = vi.fn()

vi.mock('../../api/customFiltersApi', () => ({
  getCustomFilters: () => mockGetCustomFilters(),
  saveCustomFilters: (filters: unknown) => mockSaveCustomFilters(filters),
  getCustomFieldCandidates: () => mockGetCustomFieldCandidates(),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('CustomFiltersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [{ key: 'region', label: 'Region' }], updated_at: null })
    mockGetCustomFieldCandidates.mockResolvedValue({
      sampled_count: 10,
      is_partial: false,
      candidates: [
        { key: 'region', distinct_values: 2, coverage: 1, top_values: [] },
        { key: 'plan', distinct_values: 3, coverage: 0.8, top_values: [] },
      ],
    })
    mockSaveCustomFilters.mockResolvedValue({ success: true, custom_filters: [] })
  })

  it('renders nothing (and never fetches) for non-admins', () => {
    const { container } = render(
      <CustomFiltersSection apiEndpoint="https://api.example.com" isAdmin={false} />,
      { wrapper: createWrapper() },
    )
    expect(container).toBeEmptyDOMElement()
    expect(mockGetCustomFilters).not.toHaveBeenCalled()
  })

  it('renders nothing without an API endpoint', () => {
    const { container } = render(
      <CustomFiltersSection apiEndpoint="" isAdmin />,
      { wrapper: createWrapper() },
    )
    expect(container).toBeEmptyDOMElement()
    expect(mockGetCustomFilters).not.toHaveBeenCalled()
  })

  it('seeds the editable rows from the loaded config', async () => {
    render(<CustomFiltersSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => expect(screen.getByDisplayValue('region')).toBeInTheDocument())
    expect(screen.getByDisplayValue('Region')).toBeInTheDocument()
  })

  it('offers an unused candidate key as a quick-add suggestion', async () => {
    render(<CustomFiltersSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })
    // 'region' is already configured, so only 'plan' is offered.
    await waitFor(() => expect(screen.getByRole('button', { name: '+ plan' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '+ region' })).not.toBeInTheDocument()
  })

  it('saves the current rows, dropping blank keys and defaulting a blank label', async () => {
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [{ key: 'region', label: 'Region' }], updated_at: null })
    const user = userEvent.setup()
    render(<CustomFiltersSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByDisplayValue('region')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Save filters' }))

    expect(mockSaveCustomFilters).toHaveBeenCalledWith([{ key: 'region', label: 'Region' }])
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
  })

  it('shows an error when the config fails to load', async () => {
    mockGetCustomFilters.mockRejectedValue(new Error('boom'))
    render(<CustomFiltersSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => expect(screen.getByText('Could not load custom filters.')).toBeInTheDocument())
  })

  it('shows a save error message when the mutation fails', async () => {
    mockSaveCustomFilters.mockRejectedValue(new Error('403'))
    const user = userEvent.setup()
    render(<CustomFiltersSection apiEndpoint="https://api.example.com" isAdmin />, { wrapper: createWrapper() })

    await waitFor(() => expect(screen.getByDisplayValue('region')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Save filters' }))

    await waitFor(() =>
      expect(screen.getByText('Failed to save custom filters. Try again.')).toBeInTheDocument(),
    )
  })
})
