/**
 * Save to Library for a filed voice interview: nothing without a document, a refusal when the project no longer has
 * it, and a failed upload taking its pending Library item back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createQueryWrapper } from '@test/query-client'
import { fakeXhrPerTest } from '@test/fakeXhr'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { Q3_ID, libraryItem } from '../../Library/library-fixtures'
import { useSaveInterviewToLibrary } from './useSaveInterviewToLibrary'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const xhr = fakeXhrPerTest()
const PROJECT = () => ({ project: { project_id: 'proj_1', name: 'P' }, personas: [], documents: [
  { document_id: 'doc_9', document_type: 'persona_interview', title: 'Interview with Ada — 21 Nov', content: '# x' }] })

beforeEach(() => {
  resetFetchApi()
})

describe('useSaveInterviewToLibrary', () => {
  it('does nothing without a document, and refuses one the project no longer has', async () => {
    routeFetchApi({ 'GET /projects/proj_1': () => ({ ...PROJECT(), documents: [] }) })
    const none = renderHook(() => useSaveInterviewToLibrary('proj_1', null), { wrapper: createQueryWrapper() })
    const gone = renderHook(() => useSaveInterviewToLibrary('proj_1', 'doc_9'), { wrapper: createQueryWrapper() })
    await act(() => none.result.current.mutateAsync())
    await expect(act(() => gone.result.current.mutateAsync())).rejects.toThrow('not in the project')
    expect(fetchApi.mock.calls.map(([path]) => path)).toStrictEqual(['/projects/proj_1'])
  })

  it('uploads the markdown under a name from its title, and takes the item back when the upload fails', async () => {
    routeFetchApi({
      'GET /projects/proj_1': PROJECT,
      'POST /projects/library': () => ({ item: libraryItem({ status: 'pending' }), upload: { url: 'https://s3.example.com/put', headers: {}, expires_in: 900 } }),
      [`DELETE /projects/library/${Q3_ID}`]: () => ({ success: true, deleted: Q3_ID }),
    })
    const { result } = renderHook(() => useSaveInterviewToLibrary('proj_1', 'doc_9'), { wrapper: createQueryWrapper() })
    const saving = act(() => result.current.mutateAsync())
    await vi.waitFor(() => { expect(xhr.sent).toHaveLength(1) })
    act(() => { xhr.last().respond(500) })
    await expect(saving).rejects.toThrow('The upload failed (500)')
    expect(fetchApi.mock.calls.map(([path, options]) => `${options?.method ?? 'GET'} ${path}`).slice(1)).toStrictEqual([
      'POST /projects/library', `DELETE /projects/library/${Q3_ID}`])
  })
})
