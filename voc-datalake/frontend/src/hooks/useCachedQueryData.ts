/**
 * @fileoverview `useCachedQueryData(queryKey)` — the data cached under `queryKey`, live, never fetched.
 *
 * For headers and context that show what a page already loaded (a crumb's record name, the
 * assistant's page title). It subscribes to the query CACHE, not to the query: a
 * `useQuery({ queryFn: skipToken })` observer would hand the query its options, and when it
 * rendered after the page, the query's next `invalidateQueries` refetch ran with skipToken —
 * "Missing queryFn", no request, the page in its error state (5.34.00 live: the agent page said
 * "This agent doesn't exist" after Run now or a decision, until a reload).
 *
 * @module hooks/useCachedQueryData
 */
import { useCallback, useSyncExternalStore } from 'react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'

export function useCachedQueryData(queryKey: QueryKey, enabled = true): unknown {
  const client = useQueryClient()
  const hash = hashKey(queryKey)
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === hash) onChange()
  }), [client, hash])
  const read = useCallback(
    () => (enabled ? client.getQueryCache().get(hash)?.state.data : undefined),
    [client, hash, enabled],
  )
  return useSyncExternalStore(subscribe, read, read)
}
