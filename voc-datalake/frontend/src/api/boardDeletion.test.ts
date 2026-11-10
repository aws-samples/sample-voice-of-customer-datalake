/**
 * Deleting a board: the DELETE answer's parse (an older API's `{success: true}`, the step shapes,
 * junk) and the repeat-until-done loop (running totals, the step cap, a failure stopping it).
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError } from '../lib/errors'
import { BoardDeleteIncompleteError, MAX_DELETE_STEPS, deleteBoardFully } from './boardDeletion'
import { deleteBoardStepSchema } from './featureBoardsSchema'
import { createFeatureRequestsApi } from './featureRequestsApi'
import { deleteStepsApi } from './board-deletion-fixtures'
import type { FetchApi } from './requestKit'

describe('the DELETE answer', () => {
  it.each([
    ['an older API (just success)', { success: true }, { done: true, deleted: 0, remaining: 0 }],
    ['an empty board deleted', { success: true, done: true, deleted: 0, remaining: 0 }, { done: true, deleted: 0, remaining: 0 }],
    ['a step with requests left', { success: true, done: false, deleted: 40, remaining: 12 }, { done: false, deleted: 40, remaining: 12 }],
    ['the last step', { success: true, done: true, deleted: 12, remaining: 0 }, { done: true, deleted: 12, remaining: 0 }],
    ['junk numbers', { success: true, done: false, deleted: 'x', remaining: -3 }, { done: false, deleted: 0, remaining: 0 }],
    ['a non-object body', null, { done: true, deleted: 0, remaining: 0 }],
  ])('reads %s', (_case, wire, expected) => {
    expect(deleteBoardStepSchema.parse(wire)).toStrictEqual(expected)
  })

  it('asks for the requests to go too only when told to', async () => {
    const sent: Array<[string, string | undefined]> = []
    // An older API's answer, typed for whatever the caller asks (the client parses it itself).
    const transport: FetchApi = <T,>(endpoint: string, init?: RequestInit) => {
      sent.push([endpoint, init?.method])
      return Promise.resolve(z.custom<T>(() => true).parse({ success: true }))
    }
    const api = createFeatureRequestsApi(transport)
    await api.deleteBoard('brd_1')
    await api.deleteBoard('brd_1', { withRequests: true })
    expect(sent).toStrictEqual([
      ['/feature-requests/boards/brd_1', 'DELETE'],
      ['/feature-requests/boards/brd_1?with_requests=true', 'DELETE'],
    ])
  })
})

describe('deleting a board with its requests', () => {
  it('repeats the call until the board is gone, reporting running totals', async () => {
    const api = deleteStepsApi({ done: false, deleted: 2, remaining: 3 }, { done: false, deleted: 2, remaining: 1 }, { done: true, deleted: 1, remaining: 0 })
    const onProgress = vi.fn()
    await expect(deleteBoardFully(api, 'brd_1', onProgress)).resolves.toStrictEqual({ done: true, deleted: 5, remaining: 0 })
    expect(onProgress.mock.calls.map(([progress]: unknown[]) => progress)).toStrictEqual([
      { deleted: 2, remaining: 3 }, { deleted: 4, remaining: 1 }, { deleted: 5, remaining: 0 },
    ])
    expect(api.deleteBoard).toHaveBeenCalledTimes(3)
    expect(api.deleteBoard).toHaveBeenCalledWith('brd_1', { withRequests: true })
  })

  it('stops at the first failure and throws it', async () => {
    const refused = new ApiError(503, 'unavailable')
    const api = deleteStepsApi({ done: false, deleted: 2, remaining: 3 }, refused, { done: true, deleted: 3, remaining: 0 })
    await expect(deleteBoardFully(api, 'brd_1', vi.fn())).rejects.toBe(refused)
    expect(api.deleteBoard).toHaveBeenCalledTimes(2)
  })

  it('gives up after the step cap with a clear error instead of looping forever', async () => {
    const api = { deleteBoard: vi.fn(() => Promise.resolve({ done: false, deleted: 0, remaining: 7 })) }
    const failure = await deleteBoardFully(api, 'brd_1', vi.fn()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BoardDeleteIncompleteError)
    expect(failure).toHaveProperty('message', 'The board was not deleted after 200 steps; 7 requests remain.')
    expect(api.deleteBoard).toHaveBeenCalledTimes(MAX_DELETE_STEPS)
  })
})
