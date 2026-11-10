/**
 * @fileoverview The boards' queries and the one invalidation every write ends with.
 *
 * Keys (`featureRequestKeys`) carry the hosting session (`app` | `board`), so an app session and a
 * board session in the same tab (a signed-in app user who also opened `/board`) never read each
 * other's cache.
 *
 * @module pages/FeatureRequests/useBoardQueries
 */
import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { featureRequestKeys } from '../../api/featureRequestsApi'
import { useBoardHost } from './boardContext'
import type { FeatureRequestsApi } from '../../api/featureRequestsApi'

/** The boards this caller may use (`{boards, viewer}`). */
export function useBoardList() {
  const { api, session } = useBoardHost()
  return useQuery({ queryKey: featureRequestKeys.boards(session), queryFn: () => api.listBoards() })
}

/** One board's requests and the board itself (`boardRef` = the slug or id in the URL). */
export function useRequestList(boardRef: string) {
  const { api, session } = useBoardHost()
  return useQuery({ queryKey: featureRequestKeys.list(session, boardRef), queryFn: () => api.listRequests(boardRef) })
}

export function useRequestDetail(requestId: string) {
  const { api, session } = useBoardHost()
  return useQuery({ queryKey: featureRequestKeys.detail(session, requestId), queryFn: () => api.getRequest(requestId) })
}

/**
 * Delete a request (admin): close the dialog (clears `?request=`), then refetch everything EXCEPT
 * the deleted request's detail, which would answer 404. The detail is left out of the refetch
 * rather than removed from the cache: removing it while the closing dialog's query observer is
 * still mounted (the URL change can commit after this callback) recreates the query and asks for
 * it again. Unobserved, the stale entry is garbage-collected.
 */
export function useDeleteRequest(onDeleted: () => void) {
  const { api, session } = useBoardHost()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (requestId: string) => api.deleteRequest(requestId),
    onSuccess: async (_result, requestId) => {
      onDeleted()
      const deleted = hashKey(featureRequestKeys.detail(session, requestId))
      await queryClient.invalidateQueries({
        queryKey: featureRequestKeys.root(session),
        predicate: (query) => query.queryHash !== deleted,
      })
    },
  })
}

/**
 * A board write: runs `write` with the host's API, then refetches every list, detail and the boards
 * (totals move on every support change, request counts on every new request).
 */
export function useBoardWrite<TInput, TResult>(
  write: (api: FeatureRequestsApi, input: TInput) => Promise<TResult>,
  onDone?: (result: TResult) => void,
) {
  const { api, session } = useBoardHost()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => write(api, input),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: featureRequestKeys.root(session) })
      onDone?.(result)
    },
  })
}
