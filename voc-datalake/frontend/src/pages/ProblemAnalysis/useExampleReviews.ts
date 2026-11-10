/**
 * @fileoverview The example reviews an expanded problem row shows.
 *
 * The tree carries a few sample review ids per problem, not the reviews; an
 * expanded row reads those by id (`GET /feedback/{id}`, the same `['feedback', id]`
 * cache the review page and modal use). Called only by the expanded row's body, so
 * a closed tree costs nothing.
 *
 * @module pages/ProblemAnalysis/useExampleReviews
 */
import { useQueries } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { metricsKeys } from '../../api/queryKeys'

/** Example reviews a row shows at most. */
const MAX_EXAMPLE_REVIEWS = 10

export interface ExampleReviews {
  items: FeedbackItem[]
  isLoading: boolean
  /** Some example could not be read (gone, or no longer visible to the caller). */
  isError: boolean
}

export function useExampleReviews(ids: readonly string[]): ExampleReviews {
  return useQueries({
    queries: ids.slice(0, MAX_EXAMPLE_REVIEWS).map((id) => ({
      queryKey: metricsKeys.feedback(id),
      queryFn: () => api.getFeedbackById(id),
      retry: false,
    })),
    combine: (results) => ({
      items: results.flatMap((result) => (result.data ? [result.data] : [])),
      isLoading: results.some((result) => result.isLoading),
      isError: results.some((result) => result.isError),
    }),
  })
}
