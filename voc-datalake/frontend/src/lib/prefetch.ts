/**
 * Warm the query cache before a screen needs the data.
 *
 * TanStack Query 5.105 deprecates `queryClient.prefetchQuery` in favour of `queryClient.query(options)`, which
 * resolves with the data and REJECTS on failure. A prefetch is best effort: a failed warm-up leaves the cache
 * empty and the screen's own query fetches (and reports) again when it mounts, so the rejection is dropped here.
 */
import type { QueryClient } from '@tanstack/react-query'
import { ignoreRejection } from './rejections'

type QueryOptions = Parameters<QueryClient['query']>[0]

/** The warmed data lives in the cache; the caller has no use for it. */
function discardData(): void {
  // Intentionally empty: the screen reads the data from the cache, not from this promise.
}

/** `queryClient.query(options)` with the failure dropped: the screen's own query retries and reports it. */
export function prefetch(client: QueryClient, options: QueryOptions): Promise<void> {
  return client.query(options).then(discardData, ignoreRejection)
}
