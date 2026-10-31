/**
 * Warm the query cache before a screen needs the data.
 *
 * TanStack Query 5.105 deprecates `queryClient.prefetchQuery` in favour of `queryClient.query(options)`, which
 * resolves with the data and REJECTS on failure. A prefetch is best effort: a failed warm-up leaves the cache
 * empty and the screen's own query fetches (and reports) again when it mounts, so the rejection is dropped here.
 */
import type { DefaultError, QueryClient, QueryExecuteOptions, QueryKey } from '@tanstack/react-query'
import { ignoreRejection } from './rejections'

/** The warmed data lives in the cache; the caller has no use for it. */
function discardData(): void {
  // Intentionally empty: the screen reads the data from the cache, not from this promise.
}

/**
 * `queryClient.query(options)` with the failure dropped: the screen's own query retries and reports it.
 * Generic like `query` itself, so a `queryFn` whose data does not fit the `queryKey`'s tag still fails to compile.
 */
export function prefetch<TQueryFnData, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  client: QueryClient,
  options: QueryExecuteOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>,
): Promise<void> {
  return client.query(options).then(discardData, ignoreRejection)
}
