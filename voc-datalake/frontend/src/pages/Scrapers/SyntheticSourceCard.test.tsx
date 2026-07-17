/**
 * @fileoverview Tests for SyntheticSourceCard (issue #146).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SyntheticSourceCard from './SyntheticSourceCard'
import { parseRunRecord } from './sourceRunStatus'
import { api } from '../../api/client'
import type { PluginManifest } from '../../plugins/types'

vi.mock('../../api/client', () => ({
  api: {
    getSourceRunStatus: vi.fn(),
  },
}))

const mockGetStatus = vi.mocked(api.getSourceRunStatus)

// Fully-typed fixture — satisfies PluginManifestSchema without assertions.
const plugin: PluginManifest = {
  id: 'synthetic_reviews',
  name: 'Synthetic Data Review Generator',
  icon: '🧪',
  description: 'Generate realistic synthetic customer reviews with AI.',
  category: 'synthetic',
  config: [],
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
  enabled: true,
}

function renderCard(onGenerate: () => void = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SyntheticSourceCard plugin={plugin} onGenerate={onGenerate} />
    </QueryClientProvider>
  )
}

describe('parseRunRecord', () => {
  it('returns null for the never_run sentinel', () => {
    expect(parseRunRecord({ source: 'synthetic_reviews', status: 'never_run' })).toBeNull()
  })

  it('returns null for a payload that is not a run record (wrong wire shape)', () => {
    // The list variant the mock server historically returned for this path.
    expect(parseRunRecord({ sources: [{ source: 'webscraper' }] })).toBeNull()
    expect(parseRunRecord(null)).toBeNull()
    expect(parseRunRecord('completed')).toBeNull()
  })

  it('degrades malformed optional fields instead of rejecting the record', () => {
    const record = parseRunRecord({
      status: 'completed',
      items_found: 'five',
      errors: 'oops',
      completed_at: 42,
    })
    expect(record).not.toBeNull()
    expect(record?.items_found).toBeUndefined()
    expect(record?.errors).toBeUndefined()
    expect(record?.completed_at).toBeUndefined()
  })
})

describe('SyntheticSourceCard', () => {
  beforeEach(() => {
    mockGetStatus.mockReset()
  })

  it('renders the plugin name and description', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    renderCard()

    expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
  })

  it('shows the never-run hint when there is no run history', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    renderCard()

    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/last run:/i)).not.toBeInTheDocument()
  })

  it('shows items generated, date, and a success badge for a completed run', async () => {
    mockGetStatus.mockResolvedValue({
      source: 'synthetic_reviews',
      status: 'completed',
      started_at: '2026-07-16T10:00:00Z',
      completed_at: '2026-07-16T10:01:00Z',
      items_found: 5,
      errors: [],
    })
    renderCard()

    const expectedDate = new Date('2026-07-16T10:01:00Z').toLocaleDateString()
    expect(await screen.findByText(new RegExp(`5 items generated on ${expectedDate.replace(/[/\\]/g, '\\$&')}`)))
      .toBeInTheDocument()
    expect(screen.getByText('✓')).toBeInTheDocument()
  })

  it('shows a failure badge and the first error for an errored run', async () => {
    mockGetStatus.mockResolvedValue({
      source: 'synthetic_reviews',
      status: 'error',
      started_at: '2026-07-16T10:00:00Z',
      items_found: 0,
      errors: ['Bedrock throttled'],
    })
    renderCard()

    expect(await screen.findByText('✗')).toBeInTheDocument()
    expect(screen.getByText('Bedrock throttled')).toBeInTheDocument()
  })

  it('calls onGenerate when the Generate button is clicked', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    const onGenerate = vi.fn()
    const user = userEvent.setup()
    renderCard(onGenerate)

    await user.click(screen.getByRole('button', { name: /generate/i }))

    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('fetches status through the query layer keyed by plugin id', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    renderCard()

    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('synthetic_reviews'))
  })

  it('stays render-safe when the status call fails', async () => {
    mockGetStatus.mockRejectedValue(new Error('boom'))
    renderCard()

    expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
  })
})
