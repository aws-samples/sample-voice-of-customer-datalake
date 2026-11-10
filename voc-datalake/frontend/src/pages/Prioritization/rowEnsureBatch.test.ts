/**
 * @fileoverview `ensureDefaultRows`: one request per 25 projects, one settled result
 * per project, an older API answered through the single-project shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { ApiError } from '../../lib/errors'
import { ensureDefaultRows } from './rowEnsureBatch'

const mocks = vi.hoisted(() => ({
  ensurePrioritizationRows: vi.fn<(ids: readonly string[]) => Promise<unknown>>(),
  createPrioritizationRow: vi.fn<(id: string) => Promise<unknown>>(),
}))

vi.mock('../../api/client', () => ({
  api: {
    ensurePrioritizationRows: (ids: readonly string[]) => mocks.ensurePrioritizationRows(ids),
    createPrioritizationRow: (id: string) => mocks.createPrioritizationRow(id),
  },
}))

const row = (projectId: string) => ({ row_id: `row_${projectId}_default`, project_id: projectId, document_ids: ['d1'] })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ensureDefaultRows', () => {
  it('maps rows to fulfilled and errors to rejections carrying the item status', async () => {
    mocks.ensurePrioritizationRows.mockResolvedValue({
      success: true,
      rows: [{ project_id: 'a', created: true, row: row('a') }],
      errors: [{ project_id: 'b', status: 409, error: 'Too many documents' }],
    })

    const [a, b] = await ensureDefaultRows(['a', 'b'])

    expect(a).toStrictEqual({ status: 'fulfilled', value: { created: true, row: row('a') } })
    expect(b?.status === 'rejected' ? apiErrorStatus(b.reason) : null).toBe(409)
    expect(mocks.ensurePrioritizationRows).toHaveBeenCalledTimes(1)
  })

  it('treats a project the answer does not mention as a transient failure', async () => {
    mocks.ensurePrioritizationRows.mockResolvedValue({ success: true, rows: [], errors: [{ project_id: 'x' }] })

    const [missing] = await ensureDefaultRows(['a'])

    expect(missing?.status).toBe('rejected')
    expect(missing?.status === 'rejected' ? apiErrorStatus(missing.reason) : 0).toBeNull()
  })

  it('splits past 25 projects into one request per 25', async () => {
    mocks.ensurePrioritizationRows.mockImplementation((ids) => Promise.resolve({
      success: true, rows: ids.map((id) => ({ project_id: id, created: false, row: row(id) })), errors: [],
    }))
    const ids = Array.from({ length: 26 }, (_, index) => `p${String(index)}`)

    const results = await ensureDefaultRows(ids)

    expect(mocks.ensurePrioritizationRows.mock.calls.map(([batch]) => batch.length)).toStrictEqual([25, 1])
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
  })

  it('falls back to one request per project when an older API refuses the batch with 400', async () => {
    mocks.ensurePrioritizationRows.mockRejectedValue(new ApiError(400, 'project_id is required'))
    mocks.createPrioritizationRow.mockImplementation((id) => Promise.resolve({ success: true, created: false, row: row(id) }))

    const results = await ensureDefaultRows(['a', 'b'])

    expect(mocks.createPrioritizationRow.mock.calls).toStrictEqual([['a'], ['b']])
    expect(results.map((result) => result.status)).toStrictEqual(['fulfilled', 'fulfilled'])
  })

  it('rejects every project of a request that failed outright, without falling back', async () => {
    mocks.ensurePrioritizationRows.mockRejectedValue(new ApiError(503))

    const results = await ensureDefaultRows(['a', 'b'])

    expect(results.map((result) => result.status)).toStrictEqual(['rejected', 'rejected'])
    expect(mocks.createPrioritizationRow).not.toHaveBeenCalled()
  })
})
