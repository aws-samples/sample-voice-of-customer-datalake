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

const methodOfInit = (options: unknown): unknown =>
  typeof options === 'object' && options !== null && 'method' in options ? options.method : 'GET'

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
      method: 'POST', body: JSON.stringify({ mode: 'raw', include_manual: false, days: 0 }),
    }))
  })

  it('starts a slice: a review-date range and categories', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('radio', { name: 'Date range' }))
    expect(screen.getByRole('button', { name: 'Start reprocessing' })).toBeDisabled()
    await user.type(screen.getByLabelText('From'), '2026-02-01')
    await user.type(screen.getByLabelText('To'), '2026-02-28')
    await user.selectOptions(screen.getByLabelText('Date to read'), 'review')
    await user.type(screen.getByLabelText('Categories'), 'billing, old-delivery')
    mockFetchApi.mockResolvedValueOnce({ job: { ...runningJob, status: 'queued', scanned: 0 } })
    await user.click(screen.getByRole('button', { name: 'Start reprocessing' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('2026-02-01 – 2026-02-28 (review date)')
    await user.click(within(dialog).getByRole('button', { name: 'Start reprocessing' }))
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/settings/categories/reprocess', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'processed', include_manual: false, categories: ['billing', 'old-delivery'],
        date_from: '2026-02-01', date_to: '2026-02-28', date_basis: 'review',
      }),
    }))
  })

  const partialJob = {
    ...runningJob, mode: 'raw', status: 'partial', stopped_at_ceiling: true, resumable: true,
    raw_fallback: 4, raw_fallback_sources: ['csv_upload'], sources: ['web'],
    config: { config_version: 3, categories_sha16: '0a1b2c3d4e5f6a7b', model_id: 'model-x', prompt_version: '1.1.0' },
  }

  it('shows a partial job with its slice, raw fallback and configuration', async () => {
    mockFetchApi.mockResolvedValue({ job: partialJob })
    renderPanel()
    expect(await screen.findByText('Partial')).toBeInTheDocument()
    expect(screen.getByText(/4 reviews had no archived raw item/)).toHaveTextContent('csv_upload')
    expect(screen.getByText('Sources: web')).toBeInTheDocument()
    expect(screen.getByTestId('reprocess-config')).toHaveTextContent('model-x')
  })

  const cancelledResumer = { ...runningJob, status: 'cancelled', resumed_from: 'rp_0123456789ab',
    job_id: 'rp_0123456789ac', resumable_job_id: 'rp_0123456789ab' }

  it.each([
    ['a job that stopped at the ceiling', partialJob, /per-job limit/],
    ['the job a cancelled resumer handed back', cancelledResumer, /can be resumed again/],
  ])('resumes %s', async (_case, job, note) => {
    mockFetchApi.mockResolvedValue({ job })
    const user = userEvent.setup()
    renderPanel()
    expect(await screen.findByText(note)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/settings/categories/reprocess', {
      method: 'POST', body: JSON.stringify({ resume: 'rp_0123456789ab' }),
    }))
  })

  it('explains a refused resume instead of "already running"', async () => {
    mockFetchApi.mockImplementation((_endpoint: string, options?: unknown) => (methodOfInit(options) === 'POST'
      ? Promise.reject(new Error('API Error: 409'))
      : Promise.resolve({ job: partialJob })))
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Resume' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/can no longer be resumed/)
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

  it('says why Start is disabled when more than 50 categories are named, and stops saying it at 50', async () => {
    const user = userEvent.setup()
    renderPanel()
    const names = Array.from({ length: 51 }, (_, index) => `cat-${index}`)
    const categories = screen.getByLabelText('Categories')
    await user.click(categories)
    await user.paste(names.join(', '))
    expect(screen.getByRole('alert')).toHaveTextContent('51 given; the limit is 50. Remove some to start the job.')
    expect(screen.getByRole('button', { name: 'Start reprocessing' })).toBeDisabled()

    await user.clear(categories)
    await user.paste(names.slice(0, 50).join(', '))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start reprocessing' })).toBeEnabled()
  })

  // verify5/V6: de mode labels pushed the Taxonomy tab 6 px wider than 390 px at 200 % text.
  it('lets each mode title and description wrap inside its row', async () => {
    renderPanel()
    await screen.findByText(/one model call per review/i)
    for (const text of screen.getAllByTestId('reprocess-mode-text')) {
      expect(text).toHaveClass('min-w-0', '[overflow-wrap:break-word]')
    }
  })
})
