/**
 * "Classify review types for existing reviews" (Administration → Taxonomy → Dimensions): the
 * typed / untyped counts, the cost said before anything starts, a confirmation naming the
 * number of reviews, the reprocess job in `dimensions` mode over all time keeping manual
 * values, and a 409 said in words. Nothing starts by itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../lib/errors'
import { useConfigStore } from '../../store/configStore'

const fetchApi = vi.fn<(endpoint: string, options?: unknown) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: unknown) => fetchApi(endpoint, options) }))

const { default: FeedbackTypeBackfill } = await import('./FeedbackTypeBackfill')

const METRICS = { is_partial: false, values: { bug: { count: 1200 }, praise: { count: 300 } }, unassigned: 25_000 }
const QUEUED = {
  job_id: 'rp_0123456789ab', status: 'queued', mode: 'dimensions', days: 0, include_manual: false,
  scanned: 0, updated: 0, unchanged: 0, skipped_manual: 0, failed: 0, started_by: 'admin', created_at: 't0', updated_at: 't0',
}

const methodOf = (options: unknown): unknown =>
  typeof options === 'object' && options !== null && 'method' in options ? options.method : 'GET'

/** Every POST the card sent (a job start). */
const postsSent = () => fetchApi.mock.calls.filter(([, options]) => methodOf(options) === 'POST').map(([endpoint]) => endpoint)

/** The API double: the type counts, the latest job (none) and the start answer. */
function serve(metrics: unknown = METRICS, start: () => Promise<unknown> = () => Promise.resolve({ job: QUEUED })) {
  fetchApi.mockImplementation((endpoint, options) => {
    if (endpoint.startsWith('/metrics/dimensions')) return Promise.resolve(metrics)
    return methodOf(options) === 'POST' ? start() : Promise.resolve({ job: null })
  })
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><FeedbackTypeBackfill /></QueryClientProvider>)
}

const startButton = () => screen.getByRole('button', { name: 'Classify review types' })

beforeEach(() => {
  fetchApi.mockReset()
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com' } }))
  serve()
})

describe('FeedbackTypeBackfill', () => {
  it('reads the counts for all time and shows them grouped', async () => {
    renderCard()

    expect(await screen.findByText('25,000 reviews not typed yet, 1,500 typed.')).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/metrics/dimensions?key=feedback_type&days=0', undefined)
  })

  it('says the count is a lower bound when the walk stopped early', async () => {
    serve({ ...METRICS, is_partial: true })
    renderCard()

    expect(await screen.findByText(/^At least 25,000 reviews not typed yet/)).toBeInTheDocument()
  })

  it('states the cost and starts nothing until confirmed', async () => {
    const user = userEvent.setup()
    renderCard()
    expect(screen.getByText(/one enrichment-model call per stored review/)).toBeInTheDocument()

    await user.click(startButton())

    expect(within(await screen.findByRole('dialog')).getByText(/about 26,500 stored reviews/)).toBeInTheDocument()
    expect(postsSent()).toStrictEqual([])
  })

  it('starts the dimensions reprocess over all time, keeping manual values', async () => {
    const user = userEvent.setup()
    renderCard()
    await screen.findByText(/reviews not typed yet/)

    await user.click(startButton())
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Classify review types' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/categories/reprocess', {
      method: 'POST', body: JSON.stringify({ mode: 'dimensions', days: 0, include_manual: false }),
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('says when another reprocess job is already running', async () => {
    serve(METRICS, () => Promise.reject(new ApiError(409, 'A reprocess job is already active')))
    const user = userEvent.setup()
    renderCard()

    await user.click(startButton())
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Classify review types' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A reprocess job is already running. Wait for it to finish.')
  })
})
