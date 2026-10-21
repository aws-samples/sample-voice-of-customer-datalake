import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchApi = vi.fn()
vi.mock('./client', () => ({
  // Forward only the args actually passed, so a one-arg call (GET) asserts as
  // one arg rather than picking up an undefined second parameter.
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}))

import { getDataQuality, startDataQualityJob, cancelDataQualityJob } from './dataQualityApi'

const runningEnrichJob = {
  job_id: 'dq_20261016093000_ab12cd34',
  kind: 'enrich',
  source: 'Trustpilot',
  field: 'usefulness',
  mode: 'missing',
  status: 'running',
  created_at: '2026-10-16T09:30:00+00:00',
  updated_at: '2026-10-16T09:31:00+00:00',
  total: 462,
  processed: 100,
  updated: 98,
  skipped: 1,
  failed: 1,
  planned: true,
}

// Block body on purpose: a function RETURNED from beforeEach is run as a
// teardown, and mockReset() returns the mock — which would then be invoked
// after the test and, under mockRejectedValue, fail it.
beforeEach(() => {
  mockFetchApi.mockReset()
})

describe('getDataQuality', () => {
  it('GETs the data-quality settings endpoint and returns the parsed payload', async () => {
    mockFetchApi.mockResolvedValue({
      fields: [{ name: 'usefulness', values: ['high', 'medium', 'low'] }],
      stats: {
        generated_at: '2026-10-16T09:00:00+00:00',
        scanned: 812,
        sources: [{
          source: 'Trustpilot',
          count: 812,
          ratings: { 1: 10, 5: 600, none: 78 },
          sentiments: { positive: 500 },
          lengths: { '0-100': 300 },
          enrichment: { usefulness: { high: 100, unscored: 462 } },
        }],
      },
      jobs: [runningEnrichJob],
    })

    const res = await getDataQuality()

    expect(mockFetchApi).toHaveBeenCalledWith('/settings/data-quality')
    expect(res.fields).toEqual([{ name: 'usefulness', values: ['high', 'medium', 'low'] }])
    expect(res.stats?.scanned).toBe(812)
    expect(res.stats?.sources[0].ratings).toEqual({ 1: 10, 5: 600, none: 78 })
    expect(res.stats?.sources[0].enrichment.usefulness.unscored).toBe(462)
    expect(res.jobs[0]).toMatchObject({ job_id: runningEnrichJob.job_id, status: 'running', planned: true })
    // Optional keys the server omits normalize to null rather than undefined.
    expect(res.jobs[0].completed_at).toBeNull()
    expect(res.jobs[0].error).toBeNull()
  })

  it('keeps a null stats snapshot as null (nothing profiled yet)', async () => {
    mockFetchApi.mockResolvedValue({ fields: [], stats: null, jobs: [] })
    const res = await getDataQuality()
    expect(res.stats).toBeNull()
  })

  it('coerces numeric strings in counters and counts', async () => {
    mockFetchApi.mockResolvedValue({
      stats: {
        scanned: '1234',
        sources: [{ source: 'Trustpilot', count: '812', ratings: { 5: '600', 1: 'junk' } }],
      },
      jobs: [{ job_id: 'dq_1', status: 'running', total: '10', processed: '4' }],
    })
    const res = await getDataQuality()
    expect(res.stats?.scanned).toBe(1234)
    expect(res.stats?.sources[0].count).toBe(812)
    expect(res.stats?.sources[0].ratings).toEqual({ 5: 600, 1: 0 })
    expect(res.jobs[0].total).toBe(10)
    expect(res.jobs[0].processed).toBe(4)
  })

  it('leniently defaults a partial source and job instead of throwing', async () => {
    mockFetchApi.mockResolvedValue({
      stats: { sources: [{ source: 'Reddit' }] },
      jobs: [{ job_id: 'dq_2' }],
    })
    const res = await getDataQuality()
    expect(res.fields).toEqual([])
    expect(res.stats?.generated_at).toBeNull()
    expect(res.stats?.sources[0]).toEqual({
      source: 'Reddit', count: 0, ratings: {}, sentiments: {}, lengths: {}, enrichment: {},
    })
    expect(res.jobs[0]).toMatchObject({ job_id: 'dq_2', kind: '', status: '', total: 0, planned: false })
  })

  it('drops rows with no name, source or job id', async () => {
    mockFetchApi.mockResolvedValue({
      fields: [{ values: ['x'] }, null, { name: 'usefulness', values: ['high', null] }],
      stats: { sources: [{ count: 5 }, 'garbage', { source: 'Trustpilot' }] },
      jobs: [{ status: 'running' }, 42, { job_id: 'dq_3' }],
    })
    const res = await getDataQuality()
    expect(res.fields).toEqual([{ name: 'usefulness', values: ['high'] }])
    expect(res.stats?.sources.map((s) => s.source)).toEqual(['Trustpilot'])
    expect(res.jobs.map((j) => j.job_id)).toEqual(['dq_3'])
  })

  it('never throws on a non-object payload', async () => {
    mockFetchApi.mockResolvedValue(null)
    await expect(getDataQuality()).resolves.toEqual({ fields: [], stats: null, jobs: [] })
  })
})

describe('startDataQualityJob', () => {
  it('POSTs a profile job body', async () => {
    mockFetchApi.mockResolvedValue({ success: true, job: { job_id: 'dq_4', kind: 'profile', status: 'running' } })
    const res = await startDataQualityJob({ kind: 'profile' })
    expect(mockFetchApi).toHaveBeenCalledWith('/settings/data-quality/jobs', {
      method: 'POST',
      body: JSON.stringify({ kind: 'profile' }),
    })
    expect(res.success).toBe(true)
    expect(res.job?.kind).toBe('profile')
  })

  it('POSTs an enrich job body with source, field and mode', async () => {
    mockFetchApi.mockResolvedValue({ success: true, job: runningEnrichJob })
    await startDataQualityJob({ kind: 'enrich', source: 'Trustpilot', field: 'usefulness', mode: 'all' })
    expect(mockFetchApi).toHaveBeenCalledWith('/settings/data-quality/jobs', {
      method: 'POST',
      body: JSON.stringify({ kind: 'enrich', source: 'Trustpilot', field: 'usefulness', mode: 'all' }),
    })
  })

  it('lets a 409 rejection propagate so the caller can tell a conflict apart', async () => {
    mockFetchApi.mockRejectedValue(new Error('API Error: 409'))
    await expect(startDataQualityJob({ kind: 'profile' })).rejects.toThrow('API Error: 409')
  })
})

describe('cancelDataQualityJob', () => {
  it('POSTs to the job cancel route, encoding the id', async () => {
    mockFetchApi.mockResolvedValue({ success: true, job: { ...runningEnrichJob, status: 'cancelled' } })
    const res = await cancelDataQualityJob('dq_20261016093000_ab12cd34')
    expect(mockFetchApi).toHaveBeenCalledWith(
      '/settings/data-quality/jobs/dq_20261016093000_ab12cd34/cancel',
      { method: 'POST' },
    )
    expect(res.job?.status).toBe('cancelled')
  })

  it('URL-encodes an unexpected id rather than splicing it into the path', async () => {
    mockFetchApi.mockResolvedValue({ success: true, job: null })
    await cancelDataQualityJob('a/b')
    expect(mockFetchApi).toHaveBeenCalledWith('/settings/data-quality/jobs/a%2Fb/cancel', { method: 'POST' })
  })
})
