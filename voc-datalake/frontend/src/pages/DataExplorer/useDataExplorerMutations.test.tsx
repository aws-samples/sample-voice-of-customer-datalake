/**
 * The Data Explorer's two saves: each calls its API with the selected bucket / the record, reports success to
 * its own callback (the page closes the editor there) and refreshes the listings it changed; a refused save
 * calls no callback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { api } from '../../api/client'
import { ApiError } from '../../lib/errors'
import { createQueryWrapper, createTestQueryClient } from '../../test/query-client'
import { useDataExplorerMutations } from './useDataExplorerMutations'
import { dataExplorerKeys } from './useDataExplorerQueries'

function renderMutations() {
  const client = createTestQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const callbacks = { onS3SaveSuccess: vi.fn(), onFeedbackSaveSuccess: vi.fn() }
  const { result } = renderHook(() => useDataExplorerMutations('raw-data', callbacks), { wrapper: createQueryWrapper(client) })
  return { result, callbacks, invalidate }
}

/** Saves record `fb-1` (opened unstamped) with the API answering `answer`. */
function saveFeedback(answer: Promise<{ success: boolean }>) {
  const save = vi.spyOn(api, 'saveDataExplorerFeedback').mockReturnValue(answer)
  const rendered = renderMutations()
  act(() => { rendered.result.current.saveFeedbackMutation.mutate({ feedbackId: 'fb-1', data: { updated_at: '' } }) })
  return { ...rendered, save }
}

describe('useDataExplorerMutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('saves an S3 file to the selected bucket, then refreshes both listings and reports success', async () => {
    const save = vi.spyOn(api, 'saveDataExplorerS3').mockResolvedValue({ success: true })
    const { result, callbacks, invalidate } = renderMutations()

    act(() => { result.current.saveS3Mutation.mutate({ key: 'raw/a.json', content: '{}', syncToDynamo: true }) })

    await waitFor(() => expect(callbacks.onS3SaveSuccess).toHaveBeenCalledExactlyOnceWith())
    expect(save).toHaveBeenCalledWith('raw/a.json', '{}', true, 'raw-data')
    expect(invalidate.mock.calls.map(([filters]) => filters)).toStrictEqual([
      { queryKey: dataExplorerKeys.s3() }, { queryKey: dataExplorerKeys.feedback() },
    ])
    expect(callbacks.onFeedbackSaveSuccess).not.toHaveBeenCalled()
  })

  it('saves a processed record, then refreshes the feedback listing and reports success', async () => {
    const { save, callbacks, invalidate } = saveFeedback(Promise.resolve({ success: true }))

    await waitFor(() => expect(callbacks.onFeedbackSaveSuccess).toHaveBeenCalledExactlyOnceWith())
    expect(save).toHaveBeenCalledWith('fb-1', { updated_at: '' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dataExplorerKeys.feedback() })
    expect(callbacks.onS3SaveSuccess).not.toHaveBeenCalled()
  })

  it('reports a refused save as the mutation error and calls no success callback', async () => {
    const { result, callbacks, invalidate } = saveFeedback(Promise.reject(new ApiError(400, 'category: unknown value')))

    await waitFor(() => expect(result.current.saveFeedbackMutation.error).toBeInstanceOf(ApiError))
    expect(callbacks.onFeedbackSaveSuccess).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refetches the feedback listing after a 409, so reopening the record brings its current stamp', async () => {
    const { callbacks, invalidate } = saveFeedback(Promise.reject(new ApiError(409)))

    await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: dataExplorerKeys.feedback() }))
    expect(callbacks.onFeedbackSaveSuccess).not.toHaveBeenCalled()
  })
})
