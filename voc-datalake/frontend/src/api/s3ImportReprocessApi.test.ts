/**
 * @fileoverview The S3 reprocess boundary (issue #144): each call hits its own route, an answer without a
 * `run` throws instead of rendering, and a malformed run reads as `unknown`, which counts as settled so the
 * UI never polls it forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { S3ImportRun } from './s3ImportReprocessApi'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const { fetchApi, resetFetchApi } = await import('@test/fetchApiRoutes')
const { getS3ImportReprocessRun, isRunSettled, reprocessS3ImportFile } = await import('./s3ImportReprocessApi')

const RUN = { run_id: 'run_1', key: 'web/reviews.csv', status: 'running', items_found: 12, errors: [] }

/** A run with the given status and every other field well formed. */
const runWith = (status: string): S3ImportRun => ({ ...RUN, status })

beforeEach(() => resetFetchApi())

describe('reprocessS3ImportFile', () => {
  it('posts the key to /s3-import/reprocess and returns the run', async () => {
    fetchApi.mockResolvedValue({ run: RUN })
    await expect(reprocessS3ImportFile('web/reviews.csv')).resolves.toStrictEqual(RUN)
    const [path, init] = fetchApi.mock.calls[0] ?? []
    expect(path).toBe('/s3-import/reprocess')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ key: 'web/reviews.csv' }) })
  })

  it.each([[null], [{}], [{ run: null }], [{ run: { status: 'running' } }], [{ run: { run_id: '' } }]])(
    'throws on an answer without a usable run (%j)', async (raw) => {
      fetchApi.mockResolvedValue(raw)
      await expect(reprocessS3ImportFile('k')).rejects.toThrow('Unexpected reprocess run response')
    })
})

describe('getS3ImportReprocessRun', () => {
  it('polls the run by its encoded id', async () => {
    fetchApi.mockResolvedValue({ run: RUN })
    await getS3ImportReprocessRun('run 1/2')
    // The shared double forwards (endpoint, options); a GET passes no options.
    expect(fetchApi).toHaveBeenCalledWith('/s3-import/reprocess/run%201%2F2', undefined)
  })

  it('reads malformed fields as their defaults, and an unreadable status as unknown', async () => {
    fetchApi.mockResolvedValue({ run: { run_id: 'run_1', key: 7, status: null, items_found: 'many', errors: 'x' } })
    await expect(getS3ImportReprocessRun('run_1')).resolves.toStrictEqual(
      { run_id: 'run_1', key: '', status: 'unknown', items_found: 0, errors: [] })
  })
})

describe('isRunSettled', () => {
  it.each(['completed', 'error', 'unknown'])('treats %s as settled', (status) => {
    expect(isRunSettled(runWith(status))).toBe(true)
  })

  it.each(['running', 'pending', 'queued'])('keeps polling a %s run', (status) => {
    expect(isRunSettled(runWith(status))).toBe(false)
  })
})
