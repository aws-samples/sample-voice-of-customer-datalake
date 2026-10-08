/**
 * Reprocess panel: mode choice, confirmation with the cost note, live progress
 * from the polled job, the 409 "already running" message, and cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockFetchApi = vi.fn<(endpoint: string, options?: unknown) => Promise<unknown>>()
vi.mock('../../api/client', () => ({
  fetchApi: (endpoint: string, options?: unknown) => mockFetchApi(endpoint, options),
}))

import ReprocessPanel from './ReprocessPanel'

const runningJob = {
  job_id: 'rp_0123456789ab', status: 'running', mode: 'processed', days: 0, include_manual: false,
  scanned: 30, updated: 12, unchanged: 17, skipped_manual: 1, failed: 0,
  started_by: 'admin', created_at: 't0', updated_at: 't1',
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><ReprocessPanel /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchApi.mockResolvedValue({ job: null })
})

describe('ReprocessPanel', () => {
  it('states the cost and offers both modes', async () => {
    renderPanel()
    expect(await screen.findByText(/one model call per review/i)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Re-categorise processed reviews/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Reprocess from raw data/ })).not.toBeChecked()
  })

  it('starts the chosen mode for all time after confirmation', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('radio', { name: /Reprocess from raw data/ }))
    mockFetchApi.mockResolvedValueOnce({ job: { ...runningJob, mode: 'raw', status: 'queued', scanned: 0 } })
    await user.click(screen.getByRole('button', { name: 'Start reprocessing' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Start reprocessing' }))
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/settings/categories/reprocess', {
      method: 'POST', body: JSON.stringify({ mode: 'raw', days: 0, include_manual: false }),
    }))
  })

  it('shows live counters and cancels a running job', async () => {
    mockFetchApi.mockResolvedValue({ job: runningJob })
    const user = userEvent.setup()
    renderPanel()
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Updated').nextElementSibling).toHaveTextContent('12')
    mockFetchApi.mockResolvedValue({ job: { ...runningJob, status: 'cancelled' } })
    await user.click(screen.getByRole('button', { name: 'Cancel job' }))
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/settings/categories/reprocess/rp_0123456789ab/cancel', { method: 'POST' }))
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
  })

  it('disables start while a job runs', async () => {
    mockFetchApi.mockResolvedValue({ job: runningJob })
    renderPanel()
    await screen.findByText('Running')
    expect(screen.getByRole('button', { name: 'Start reprocessing' })).toBeDisabled()
  })

  it('explains a 409 as a job already running', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText(/one model call per review/i)
    mockFetchApi.mockRejectedValueOnce(new Error('API Error: 409'))
    await user.click(screen.getByRole('button', { name: 'Start reprocessing' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start reprocessing' }))
    expect(await screen.findByText(/already running/i)).toBeInTheDocument()
  })

  it('explains a job that stopped at the cost ceiling', async () => {
    mockFetchApi.mockResolvedValue({ job: { ...runningJob, status: 'completed', stopped_at_ceiling: true } })
    renderPanel()
    expect(await screen.findByText(/per-job limit of 50,000 reviews/)).toBeInTheDocument()
  })

  it('shows no ceiling notice for a legacy job without the field', async () => {
    mockFetchApi.mockResolvedValue({ job: { ...runningJob, status: 'completed' } })
    renderPanel()
    await screen.findByText('Completed')
    expect(screen.queryByText(/per-job limit/)).not.toBeInTheDocument()
  })

  it('refuses a window outside 0–9999', async () => {
    const user = userEvent.setup()
    renderPanel()
    const days = screen.getByLabelText('Window (days)')
    await user.clear(days)
    await user.type(days, '10000')
    expect(screen.getByRole('button', { name: 'Start reprocessing' })).toBeDisabled()
  })
})
