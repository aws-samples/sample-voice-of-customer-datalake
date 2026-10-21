/**
 * @fileoverview Tests for the admin Settings → Data Quality tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DataQualityJob, DataQualityResponse } from '../../api/dataQualityApi'
import DataQualitySection from './DataQualitySection'

const mockGetDataQuality = vi.fn()
const mockStartDataQualityJob = vi.fn()
const mockCancelDataQualityJob = vi.fn()

// Same approach as Dashboard.test.tsx. The global ResizeObserver stub in
// test/setup.ts is an arrow-function mock, which Vitest 4 cannot `new`, so the
// real ResponsiveContainer throws on mount. The chart headings and the
// text summaries given to assistive tech are this component's own markup, so
// they are still asserted below.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: () => <div data-testid="bar-chart" />,
  Bar: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

vi.mock('../../api/dataQualityApi', async (importOriginal) => ({
  // Keep the real wire constants (UNSCORED_BUCKET, OVERFLOW_SOURCE).
  ...(await importOriginal<typeof import('../../api/dataQualityApi')>()),
  getDataQuality: () => mockGetDataQuality(),
  startDataQualityJob: (body: unknown) => mockStartDataQualityJob(body),
  cancelDataQualityJob: (jobId: unknown) => mockCancelDataQualityJob(jobId),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function job(overrides: Partial<DataQualityJob>): DataQualityJob {
  return {
    job_id: 'dq_20261016093000_ab12cd34', kind: 'enrich', source: 'Trustpilot', field: 'usefulness',
    mode: 'missing', status: 'completed', created_at: '2026-10-16T09:30:00+00:00',
    updated_at: '2026-10-16T09:31:00+00:00', completed_at: null, error: null,
    total: 0, processed: 0, updated: 0, skipped: 0, failed: 0, planned: true,
    ...overrides,
  }
}

function payload(overrides: Partial<DataQualityResponse> = {}): DataQualityResponse {
  return {
    fields: [{ name: 'usefulness', values: ['high', 'medium', 'low'] }],
    stats: {
      generated_at: '2026-10-16T09:00:00+00:00',
      scanned: 1012,
      sources: [
        {
          source: 'Trustpilot', count: 812,
          ratings: { 1: 10, 2: 4, 3: 20, 4: 100, 5: 600, none: 78 },
          sentiments: { positive: 500, negative: 200, neutral: 100, mixed: 12 },
          lengths: { '0-100': 300, '101-500': 400, '501-1000': 80, '1001-2000': 30, '2000+': 2 },
          enrichment: { usefulness: { high: 100, medium: 200, low: 50, unscored: 462 } },
        },
        {
          source: 'Reddit', count: 200,
          ratings: { none: 200 },
          sentiments: { positive: 120, negative: 80 },
          lengths: { '0-100': 200 },
          enrichment: { usefulness: { high: 50, medium: 100, low: 50, unscored: 0 } },
        },
      ],
    },
    jobs: [],
    ...overrides,
  }
}

const renderSection = (isAdmin = true, apiEndpoint = 'https://api.example.com') =>
  render(<DataQualitySection apiEndpoint={apiEndpoint} isAdmin={isAdmin} />, { wrapper: createWrapper() })

/** The source card (a labelled region) once the first read has landed. */
async function sourceCard(source: string) {
  return within(await screen.findByRole('region', { name: source }))
}

describe('DataQualitySection', () => {
  beforeEach(() => {
    mockGetDataQuality.mockResolvedValue(payload())
    mockStartDataQualityJob.mockResolvedValue({ success: true, job: job({ status: 'running' }) })
    mockCancelDataQualityJob.mockResolvedValue({ success: true, job: job({ status: 'cancelled' }) })
  })

  it('renders nothing (and never fetches) for non-admins', () => {
    const { container } = renderSection(false)
    expect(container).toBeEmptyDOMElement()
    expect(mockGetDataQuality).not.toHaveBeenCalled()
  })

  it('renders nothing without an API endpoint', () => {
    const { container } = renderSection(true, '')
    expect(container).toBeEmptyDOMElement()
    expect(mockGetDataQuality).not.toHaveBeenCalled()
  })

  it('renders one card per source with its chart headings and unscored share', async () => {
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    expect(trustpilot.getByText('812 rows')).toBeInTheDocument()
    for (const heading of ['Rating', 'Sentiment', 'Usefulness', 'Text length (characters)']) {
      expect(trustpilot.getByRole('heading', { name: heading })).toBeInTheDocument()
    }
    // 462 of 812 rows have no usefulness value.
    expect(trustpilot.getByText('462 unscored (57%)')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Reddit' })).toBeInTheDocument()
    expect(screen.getByText(/rows scanned/)).toHaveTextContent('1,012 rows scanned')
  })

  it('labels chart values from the registry and gives assistive tech the numbers', async () => {
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    expect(trustpilot.getByRole('img', { name: /^Usefulness: High 100, Medium 200, Low 50, Unscored 462$/ }))
      .toBeInTheDocument()
  })

  it('falls back to the raw name for a registry field with no translation', async () => {
    mockGetDataQuality.mockResolvedValue(payload({
      fields: [{ name: 'effort', values: ['easy', 'hard'] }],
    }))
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    expect(trustpilot.getByRole('heading', { name: 'effort' })).toBeInTheDocument()
    expect(trustpilot.getByRole('img', { name: /^effort: easy 0, hard 0, Unscored 0$/ })).toBeInTheDocument()
  })

  it('shows the empty state when no snapshot exists yet', async () => {
    mockGetDataQuality.mockResolvedValue(payload({ stats: null }))
    renderSection()
    expect(await screen.findByText('No statistics yet — run Refresh statistics.')).toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh statistics' })).toBeEnabled()
  })

  it('shows an error when the read fails', async () => {
    mockGetDataQuality.mockRejectedValue(new Error('API Error: 500'))
    renderSection()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load data quality statistics.')
  })

  it('starts a profile job from Refresh statistics', async () => {
    const user = userEvent.setup()
    renderSection()
    await sourceCard('Trustpilot')
    await user.click(screen.getByRole('button', { name: 'Refresh statistics' }))
    expect(mockStartDataQualityJob).toHaveBeenCalledWith({ kind: 'profile' })
  })

  it('disables Refresh statistics while a profile job runs', async () => {
    mockGetDataQuality.mockResolvedValue(payload({
      jobs: [job({ kind: 'profile', source: null, field: null, mode: null, status: 'running', processed: 300 })],
    }))
    renderSection()
    await sourceCard('Trustpilot')
    expect(screen.getByRole('button', { name: 'Refresh statistics' })).toBeDisabled()
    expect(screen.getByText('Scanning… 300 rows')).toBeInTheDocument()
  })

  it('"Calculate missing" posts an enrich job for that source and field', async () => {
    const user = userEvent.setup()
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    await user.click(trustpilot.getByRole('button', { name: 'Calculate missing' }))
    expect(mockStartDataQualityJob).toHaveBeenCalledWith({
      kind: 'enrich', source: 'Trustpilot', field: 'usefulness', mode: 'missing',
    })
  })

  it('disables "Calculate missing" when nothing is unscored', async () => {
    renderSection()
    const reddit = await sourceCard('Reddit')
    expect(reddit.getByRole('button', { name: 'Calculate missing' })).toBeDisabled()
    expect(reddit.getByRole('button', { name: 'Recalculate all' })).toBeEnabled()
  })

  it('"Recalculate all" asks for confirmation before posting mode=all', async () => {
    const user = userEvent.setup()
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    await user.click(trustpilot.getByRole('button', { name: 'Recalculate all' }))

    const dialog = screen.getByRole('dialog', { name: 'Recalculate Usefulness for Trustpilot?' })
    expect(dialog).toHaveTextContent('812 rows')
    expect(dialog).toHaveTextContent('one model call per row')
    expect(mockStartDataQualityJob).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Recalculate all' }))
    expect(mockStartDataQualityJob).toHaveBeenCalledWith({
      kind: 'enrich', source: 'Trustpilot', field: 'usefulness', mode: 'all',
    })
  })

  it('cancelling the confirmation starts nothing', async () => {
    const user = userEvent.setup()
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    await user.click(trustpilot.getByRole('button', { name: 'Recalculate all' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockStartDataQualityJob).not.toHaveBeenCalled()
  })

  it('disables both enrich buttons only for the source + field whose job is running', async () => {
    mockGetDataQuality.mockResolvedValue(payload({
      jobs: [job({ status: 'running', total: 462, processed: 100, planned: false })],
    }))
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    expect(trustpilot.getByRole('button', { name: 'Calculate missing' })).toBeDisabled()
    expect(trustpilot.getByRole('button', { name: 'Recalculate all' })).toBeDisabled()
    const reddit = await sourceCard('Reddit')
    expect(reddit.getByRole('button', { name: 'Recalculate all' })).toBeEnabled()
  })

  it('lists a running enrich job with progress, planning note and a Cancel that posts', async () => {
    const running = job({ status: 'running', total: 462, processed: 100, updated: 98, skipped: 1, failed: 1, planned: false })
    mockGetDataQuality.mockResolvedValue(payload({ jobs: [running] }))
    const user = userEvent.setup()
    renderSection()
    await sourceCard('Trustpilot')

    expect(screen.getByText('Usefulness · Trustpilot · Missing only')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Job progress' })).toHaveAttribute('aria-valuenow', '22')
    expect(screen.getByText('100 / 462 · Still planning — more rows may be added')).toBeInTheDocument()
    expect(screen.getByText('98 updated · 1 skipped · 1 failed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockCancelDataQualityJob).toHaveBeenCalledWith(running.job_id)
  })

  it('shows a failed job’s error and offers no Cancel for finished jobs', async () => {
    mockGetDataQuality.mockResolvedValue(payload({
      jobs: [job({ status: 'failed', error: 'Bedrock throttled', total: 10, processed: 4 })],
    }))
    renderSection()
    await sourceCard('Trustpilot')
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Bedrock throttled')
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('shows a friendly message when a start is refused with 409, and re-reads the jobs', async () => {
    mockStartDataQualityJob.mockRejectedValue(new Error('API Error: 409'))
    const user = userEvent.setup()
    renderSection()
    const trustpilot = await sourceCard('Trustpilot')
    expect(mockGetDataQuality).toHaveBeenCalledTimes(1)

    await user.click(trustpilot.getByRole('button', { name: 'Calculate missing' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A job is already running for that target. Wait for it to finish or cancel it first.',
    )
    await waitFor(() => expect(mockGetDataQuality).toHaveBeenCalledTimes(2))
  })

  it('shows a generic message for any other start failure', async () => {
    mockStartDataQualityJob.mockRejectedValue(new Error('API Error: 500'))
    const user = userEvent.setup()
    renderSection()
    await sourceCard('Trustpilot')
    await user.click(screen.getByRole('button', { name: 'Refresh statistics' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the job. Try again.')
  })

  it('explains a 409 on cancel as the job having already stopped', async () => {
    mockGetDataQuality.mockResolvedValue(payload({ jobs: [job({ status: 'running', total: 10, processed: 2 })] }))
    mockCancelDataQualityJob.mockRejectedValue(new Error('API Error: 409'))
    const user = userEvent.setup()
    renderSection()
    await sourceCard('Trustpilot')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That job had already stopped.')
  })

  it('offers no enrich actions on the overflow bucket', async () => {
    const base = payload()
    mockGetDataQuality.mockResolvedValue(payload({
      stats: base.stats && {
        ...base.stats,
        sources: [{ ...base.stats.sources[0], source: '(other sources)' }],
      },
    }))
    renderSection()
    const overflow = await sourceCard('(other sources)')
    expect(overflow.queryByRole('button', { name: 'Calculate missing' })).not.toBeInTheDocument()
    expect(overflow.queryByRole('button', { name: 'Recalculate all' })).not.toBeInTheDocument()
  })
})
