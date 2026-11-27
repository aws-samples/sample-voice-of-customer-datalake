/**
 * The Extract at the Sources card's foot (7.104.00): off until a source is ready, a question first when sources are
 * still read, its steps and time while it runs, and when it failed why and what to do, by the job's code in the
 * person's language (the job as shared/jobs.py records it): a refusal, a time-out with "Retry at xhigh" (the person's
 * choice), a stale job (the Background Jobs panel's threshold), a start refused as busy or rate limited (and, while a
 * stopped extract's lock holds, when to try again), Try again off while its start is under way. The hook is
 * driven through the jobs list (`extract_product_description`), and a completed job reads the proposal.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import enProjectDetail from '../../../public/locales/en/projectDetail.json'
import { ApiError } from '../../lib/errors'
import { PROJECT, extractJob, extractStub, sourceDoc } from './product-sources-fixtures'
import ProductExtractPanel from './ProductExtractPanel'
import { STALE_THRESHOLD_MS } from './jobStaleness'
import { latestExtractJob, useProductExtract } from './useProductExtract'
import type { ProductDoc, ProjectJob } from '../../api/projectTypes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const JOBS = `/projects/${PROJECT}/jobs`

/** A failed extract as shared/jobs.py records it: the decorator's message before the reason (`error`), the reason as a
 * word (`error_code`), progress 0 at the step `error`. */
function failedJob(code: NonNullable<ProjectJob['error_code']>, reason: string): ProjectJob {
  return extractJob({ status: 'failed', progress: 0, current_step: 'error', error_code: code, error: `Document generation failed: ${reason.slice(0, 200)}` })
}
const EXTRACT = `/projects/${PROJECT}/product-extract`

function Harness({ docs }: Readonly<{ docs: ProductDoc[] }>) {
  return <ProductExtractPanel docs={docs} extract={useProductExtract(PROJECT)} />
}

function renderWithJobs(jobs: ProjectJob[], docs: ProductDoc[] = [sourceDoc()], start: () => unknown = () => ({ job_id: 'job-2' }),
  client = createTestQueryClient()) {
  routeFetchApi({ [`GET ${JOBS}`]: () => ({ success: true, jobs }), [`POST ${EXTRACT}`]: start })
  renderWithQueryClient(<Harness docs={docs} />, client)
}

beforeEach(() => {
  resetFetchApi()
})

describe('ProductExtractPanel', () => {
  it('stays off until a source is ready', () => {
    renderWithQueryClient(<ProductExtractPanel docs={[sourceDoc({ status: 'extracting' })]} extract={extractStub()} />)
    expect(screen.getByRole('button', { name: /extract product description/i })).toBeDisabled()
    expect(screen.getByText('Add a source and wait until it is ready.')).toBeInTheDocument()
  })

  it('starts at max effort in the UI language, and asks first while sources are still read', async () => {
    const user = userEvent.setup()
    renderWithJobs([], [sourceDoc(), sourceDoc({ doc_id: 'b', status: 'extracting' }), sourceDoc({ doc_id: 'c', status: 'pending' })])
    await user.click(screen.getByRole('button', { name: /extract product description/i }))
    expect(screen.getByText('2 sources are still being read and will be left out. Extract now?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Extract now' }))
    await waitFor(() => expect(sentFetchApiBody(EXTRACT, 'POST')).toStrictEqual({ response_language: 'en', effort: 'max' }))
    expect(await screen.findByRole('button', { name: /extracting/i })).toBeDisabled()
  })

  it('shows the running job\'s step and its time so far', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-25T09:02:05Z') })
    renderWithJobs([extractJob({ created_at: '2026-11-25T09:00:00Z', current_step: 'thinking' })])
    expect(await screen.findByRole('status')).toHaveTextContent('Thinking (2:05)…')
    vi.useRealTimers()
  })

  it.each([
    ['starting', 'Starting…'],
    ['reading_sources', 'Reading the sources…'],
    ['checking_citations', 'Checking the citations…'],
    ['saved', 'Proposal saved, finishing…'],
    [undefined, 'Waiting to start…'],
  ])('names the step %s', async (step, text) => {
    renderWithJobs([extractJob({ current_step: step, status: step === undefined ? 'pending' : 'running' })])
    expect(await screen.findByRole('status')).toHaveTextContent(text)
  })

  it('offers Retry at xhigh after a time-out, and sends xhigh only when the person chooses it', async () => {
    const user = userEvent.setup()
    renderWithJobs([failedJob('timed_out', 'The extract took more than 12 minutes and was stopped. Try again with fewer or shorter sources.')])
    expect(await screen.findByRole('alert')).toHaveTextContent(/took more than 12 minutes and was stopped/)
    expect(fetchApi.mock.calls.some(([path]) => path === EXTRACT)).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Retry at xhigh' }))
    await waitFor(() => expect(sentFetchApiBody(EXTRACT, 'POST')).toStrictEqual({ response_language: 'en', effort: 'xhigh' }))
  })

  it('says a refusal in the person\'s language, never the server\'s English, with no xhigh retry', async () => {
    renderWithJobs([failedJob('refused', 'The model declined to read these sources (violence). Remove the source that may have caused it and try again.')])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The model declined to read these sources. Remove the source that may have caused it and try again.')
    expect(alert).not.toHaveTextContent(/Document generation failed|violence/)
    expect(screen.queryByRole('button', { name: 'Retry at xhigh' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it.each([
    ['cut', 'The extract ran out of room before it finished. Try again with fewer or shorter sources.', /ran out of room/],
    ['unreadable', "The model's answer could not be read as a proposal. Try again.", /could not be read/],
  ] as const)('says a %s failure', async (code, error, text) => {
    renderWithJobs([failedJob(code, error)])
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('takes an extract with no progress for the Background Jobs panel\'s threshold for stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-25T09:30:00Z') })
    renderWithJobs([extractJob({ updated_at: new Date(Date.now() - STALE_THRESHOLD_MS - 60_000).toISOString() })])
    expect(await screen.findByRole('alert')).toHaveTextContent('This extract stopped reporting progress. Try again.')
    expect(screen.getByRole('button', { name: /extract product description/i })).toBeEnabled()
    vi.useRealTimers()
  })

  it('keeps an extract that wrote progress within that threshold running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-25T09:30:00Z') })
    renderWithJobs([extractJob({ updated_at: new Date(Date.now() - STALE_THRESHOLD_MS + 60_000).toISOString() })])
    expect(await screen.findByRole('status')).toHaveTextContent(/Thinking/)
    expect(screen.getByRole('button', { name: /extracting/i })).toBeDisabled()
    vi.useRealTimers()
  })

  it.each([
    ['extract_running', 409, /already running for this project/],
    ['rate_limited', 429, /at most 1 a minute and 10 a day per project/],
    ['no_ready_sources', 400, /No source is ready yet/],
  ])('says a start refused as %s', async (code, status, text) => {
    const user = userEvent.setup()
    renderWithJobs([], [sourceDoc()], () => { throw new ApiError(status, 'refused', code) })
    await user.click(screen.getByRole('button', { name: /extract product description/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('turns Try again and Retry at xhigh off while their start is under way', () => {
    // Review Q7 (7.104.00 round 2): both stayed on while the start was pending, so a second click sent a second start.
    renderWithQueryClient(<ProductExtractPanel docs={[sourceDoc()]} extract={extractStub({
      job: failedJob('timed_out', 'The extract took more than 12 minutes and was stopped.'), pending: true,
    })} />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retry at xhigh' })).toBeDisabled()
  })

  it('says when a stopped extract can be tried again while its lock still holds', async () => {
    // Review Q9 (7.104.00 round 2): the panel takes an extract for stopped after 10 minutes without progress, but the
    // server's lock holds it 16 minutes from its start; Try again's 409 said only "already running".
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-25T09:12:00Z') })
    const user = userEvent.setup()
    const stopped = extractJob({ created_at: '2026-11-25T09:00:00Z', updated_at: '2026-11-25T09:01:00Z' })
    renderWithJobs([stopped], [sourceDoc()], () => { throw new ApiError(409, 'An extract is already running for this project', 'extract_running') })
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('The stopped extract still holds this project until about 16 minutes after it started. Try again then.')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('names the lock\'s own time in that line (shared/product_proposals.py LOCK_STALE_SECONDS)', () => {
    const source = readFileSync(join(__dirname, '../../../../lambda/shared/product_proposals.py'), 'utf8')
    const minutes = /^LOCK_STALE_SECONDS: Final = (\d+) \* 60$/m.exec(source)?.[1]
    expect(minutes).toBe('16')
    expect(enProjectDetail.product.extract.errors.busyStale).toContain(`about ${String(minutes)} minutes after it started`)
  })

  it('reads the proposal again once the extract completed', async () => {
    const client = createTestQueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderWithJobs([extractJob({ status: 'completed', result: { proposal_id: 'pp-1' } })], [sourceDoc()], () => ({ job_id: 'x' }), client)
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['product-proposal', PROJECT] }))
  })
})

describe('latestExtractJob', () => {
  it('takes the newest extract, whatever else the list holds', () => {
    const jobs = [
      extractJob({ job_id: 'old', created_at: '2026-11-24T09:00:00Z' }),
      { ...extractJob({ job_id: 'report', created_at: '2026-11-26T09:00:00Z' }), job_type: 'generate_product_report' as const },
      extractJob({ job_id: 'new', created_at: '2026-11-25T09:00:00Z' }),
    ]
    expect(latestExtractJob(jobs)?.job_id).toBe('new')
  })
})
