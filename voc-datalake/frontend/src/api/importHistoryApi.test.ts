/**
 * @fileoverview The import-history boundary (#237): each call hits its own route, a row without a run id is
 * dropped, missing counts read as 0, an unknown method or status as `unknown`, and a malformed answer reads
 * as an empty page or no run instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const { fetchApi, resetFetchApi } = await import('@test/fetchApiRoutes')
const { importHistoryApi, normalizeImportHistoryPage, normalizeImportRunDetail } = await import('./importHistoryApi')

const COUNTS = { received: 10, imported: 8, skipped: 1, duplicate: 1, failed: 0 }
const RUN = {
  run_id: 'run_1', method: 'csv', source: 'Example Air reviews', source_id: 'csv_upload', actor: 'sub-1',
  actor_email: 'ops@example.com', started_at: '2026-10-30T10:00:00Z', finished_at: '2026-10-30T10:00:05Z',
  counts: COUNTS, status: 'completed', warning_count: 0, error_count: 0, truncated: false,
}

beforeEach(() => resetFetchApi())

describe('normalizeImportHistoryPage', () => {
  it('keeps well-formed runs and the cursor, and drops a row without a run id', () => {
    const page = normalizeImportHistoryPage({ runs: [RUN, { ...RUN, run_id: '' }], next_cursor: 'c2' })
    expect(page.runs.map((r) => r.run_id)).toStrictEqual(['run_1'])
    expect(page.next_cursor).toBe('c2')
  })

  it('reads unknown method and status as unknown and missing counts as 0', () => {
    const [run] = normalizeImportHistoryPage({ runs: [{ run_id: 'run_2', method: 'fax', status: 'odd' }] }).runs
    expect(run).toMatchObject({ method: 'unknown', status: 'unknown', warning_count: 0, truncated: false })
    expect(run?.counts).toStrictEqual({ received: 0, imported: 0, skipped: 0, duplicate: 0, failed: 0 })
  })

  it.each([[null], ['x'], [{ runs: 'nope' }]])('reads %j as an empty page', (raw) => {
    const page = normalizeImportHistoryPage(raw)
    expect(page.runs).toStrictEqual([])
    expect(page.next_cursor).toBeUndefined()
  })
})

describe('normalizeImportRunDetail', () => {
  it('keeps the warnings and errors of a run', () => {
    const run = normalizeImportRunDetail({ run: { ...RUN, warnings: ['row 3: no text'], errors: 'x' } })
    expect(run).toMatchObject({ run_id: 'run_1', warnings: ['row 3: no text'], errors: [] })
  })

  it.each([[null], [{}], [{ run: { run_id: '' } }]])('reads %j as no run', (raw) => {
    expect(normalizeImportRunDetail(raw)).toBeNull()
  })
})

describe('importHistoryApi', () => {
  it('lists the first page with the page size and no cursor', async () => {
    fetchApi.mockResolvedValue({ runs: [RUN] })
    await importHistoryApi.list()
    expect(fetchApi).toHaveBeenCalledWith('/scrapers/manual/history?limit=25', undefined)
  })

  it('passes the cursor of a later page', async () => {
    fetchApi.mockResolvedValue({ runs: [] })
    await importHistoryApi.list('c2')
    expect(fetchApi).toHaveBeenCalledWith('/scrapers/manual/history?limit=25&cursor=c2', undefined)
  })

  it('reads one run by its encoded id', async () => {
    fetchApi.mockResolvedValue({ run: RUN })
    await expect(importHistoryApi.get('run 1/2')).resolves.toMatchObject({ run_id: 'run_1', warnings: [] })
    expect(fetchApi).toHaveBeenCalledWith('/scrapers/manual/history/run%201%2F2', undefined)
  })
})
