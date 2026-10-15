/**
 * The wire boundary for a prioritization row's lifecycle.
 *
 * What these assert is the REQUEST — the method, the address and the exact body —
 * because that is what the shipped routes read, and a client that composes a
 * plausible-looking request the API refuses is indistinguishable at a glance from
 * one that works. Plus the one response field the page cannot re-read: a delete
 * removes the row, so `ballots_deleted` is the only evidence the ballots went with
 * it.
 */
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'

const mockFetchApi = vi.fn()
vi.mock('./client', () => ({
  fetchApi: (path: string, init?: RequestInit) => mockFetchApi(path, init),
}))

import { prioritizationRowsApi } from './prioritizationRowsApi'

/** The body of the request the client last made, as the route will read it. */
function sentBody(): unknown {
  const init: unknown = mockFetchApi.mock.calls[0][1]
  const body = init instanceof Object && 'body' in init ? init.body : undefined
  return typeof body === 'string' ? JSON.parse(body) : undefined
}

/** The method the request declared, or undefined for a plain GET. */
function sentMethod(): unknown {
  const init: unknown = mockFetchApi.mock.calls[0][1]
  return init instanceof Object && 'method' in init ? init.method : undefined
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('composing another row', () => {
  it('posts the project and the document ids to the compose route', async () => {
    mockFetchApi.mockResolvedValue({ success: true, created: true })

    await prioritizationRowsApi.composePrioritizationRow({
      project_id: 'p1', document_ids: ['d1', 'd2'],
    })

    expect(mockFetchApi.mock.calls[0][0]).toBe('/projects/prioritization/rows/compose')
    expect(sentMethod()).toBe('POST')
    // The EXACT shape the route reads: `project_id` and `document_ids`, and nothing
    // else. A body carrying a `row_id` would be a caller choosing a key the API mints
    // (`_minted_row_id`), and one naming `documents` would be silently ignored and
    // then refused as an empty set.
    expect(sentBody()).toStrictEqual({ project_id: 'p1', document_ids: ['d1', 'd2'] })
  })
})

describe('changing an un-balloted row composition', () => {
  it('patches the row address with the project and the document ids', async () => {
    mockFetchApi.mockResolvedValue({ success: true })

    await prioritizationRowsApi.recomposePrioritizationRow('row_p1_default', {
      project_id: 'p1', document_ids: ['d2'],
    })

    expect(mockFetchApi.mock.calls[0][0]).toBe('/projects/prioritization/rows/row_p1_default')
    expect(sentMethod()).toBe('PATCH')
    // `project_id` is in the body deliberately: the API validates the ids against
    // that project's own documents and asserts it in the write's condition, so a
    // body without it could install one project's documents on another's row.
    expect(sentBody()).toStrictEqual({ project_id: 'p1', document_ids: ['d2'] })
  })

  it('escapes a row id that would otherwise address another resource', async () => {
    mockFetchApi.mockResolvedValue({ success: true })

    await prioritizationRowsApi.recomposePrioritizationRow('row/../other?x=1', {
      project_id: 'p1', document_ids: ['d1'],
    })

    // Not `/projects/prioritization/rows/row/../other?x=1`, which is a different
    // route with a query string. The ids the product mints need no escaping; this is
    // a path segment built from a value read off a response.
    expect(mockFetchApi.mock.calls[0][0])
      .toBe('/projects/prioritization/rows/row%2F..%2Fother%3Fx%3D1')
  })
})

describe('deleting a row with its ballots', () => {
  it('reports how many ballots went with the row', async () => {
    mockFetchApi.mockResolvedValue({ success: true, row_id: 'row-1', ballots_deleted: 4 })

    const deletion = await prioritizationRowsApi.deletePrioritizationRow('row-1')

    expect(mockFetchApi.mock.calls[0][0]).toBe('/projects/prioritization/rows/row-1')
    expect(sentMethod()).toBe('DELETE')
    expect(deletion.ballots_deleted).toBe(4)
  })

  it('reports no ballots rather than failing when the receipt cannot be read', async () => {
    // The row is already gone by the time this parses, so an unreadable body is a
    // successful delete with an unreadable receipt — not a failure to put on screen.
    // Rejecting here would tell a reviewer their delete failed while the row had in
    // fact been removed, which the next read then contradicts.
    mockFetchApi.mockResolvedValue(null)

    await expect(prioritizationRowsApi.deletePrioritizationRow('row-1'))
      .resolves.toStrictEqual({ ballots_deleted: 0 })
  })

  it('reports no ballots rather than a fabricated count for a nonsense number', async () => {
    mockFetchApi.mockResolvedValue({ ballots_deleted: 'lots' })

    const deletion = await prioritizationRowsApi.deletePrioritizationRow('row-1')

    expect(deletion.ballots_deleted).toBe(0)
  })

  it('rejects when the request itself failed, so the page can say so', async () => {
    // The other direction, and the one the lenient parsing must not swallow: a 403
    // for a non-admin or a 409 for a row that changed mid-delete never reaches the
    // parser, and the page's error copy depends on the rejection surviving.
    mockFetchApi.mockRejectedValue(new Error('API Error: 409'))

    await expect(prioritizationRowsApi.deletePrioritizationRow('row-1'))
      .rejects.toThrow('API Error: 409')
  })
})
