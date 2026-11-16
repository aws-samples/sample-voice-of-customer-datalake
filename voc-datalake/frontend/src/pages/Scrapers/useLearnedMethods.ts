/**
 * @fileoverview The methods this workspace learned for its review sites (api/webReviewMethodsApi.ts), read once for
 * every card of the page, and "Re-check methods": an admin clears one site's record so its next run tries every
 * method again. Each card gets its site's state ({@link LearnedMethod}).
 * @module pages/Scrapers/useLearnedMethods
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { webReviewMethodsApi, webReviewMethodsKey } from '../../api/webReviewMethodsApi'
import { useConfigStore } from '../../store/configStore'
import type { WebReviewMethodRecord } from '../../api/webReviewMethodsApi'

/** One card's site: what was learned, and its Re-check action. */
export interface LearnedMethod {
  readonly record: WebReviewMethodRecord | undefined
  /** Cleared by this page: the next run tries every method again. */
  readonly cleared: boolean
  readonly pending: boolean
  readonly failed: boolean
  readonly onRecheck: () => void
}

/** `(domain) => its state`; `enabled` false (no review page listed) reads nothing. */
export function useLearnedMethods(enabled: boolean): (domain: string) => LearnedMethod {
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set())
  const { data } = useQuery({
    queryKey: webReviewMethodsKey(),
    queryFn: webReviewMethodsApi.list,
    enabled: enabled && config.apiEndpoint.length > 0,
  })
  const recheck = useMutation({
    mutationFn: (domain: string) => webReviewMethodsApi.clear(domain),
    onSuccess: async (_answer, domain) => {
      setCleared((previous) => new Set([...previous, domain]))
      await queryClient.invalidateQueries({ queryKey: webReviewMethodsKey() })
    },
  })
  return (domain) => {
    const mine = recheck.variables === domain
    return {
      record: data?.find((record) => record.domain === domain),
      cleared: cleared.has(domain),
      pending: mine && recheck.isPending,
      failed: mine && recheck.isError,
      onRecheck: () => { recheck.mutate(domain) },
    }
  }
}
