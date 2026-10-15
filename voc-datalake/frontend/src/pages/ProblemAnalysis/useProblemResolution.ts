/**
 * @fileoverview Hook owning the shared problem-resolution state (issue #66).
 *
 * Wraps the resolved-problems query (deliberate freshness policy for shared
 * state) and the resolve/unresolve mutation, keeping the query/mutation
 * wiring out of the page component's complexity budget — same convention as
 * Settings' useSettingsSync.
 * @module pages/ProblemAnalysis/useProblemResolution
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { parseResolvedProblemsResponse } from './problemResolution'
import type { ResolvedProblemsMap } from './problemResolution'

interface ProblemResolutionState {
  resolvedMap: ResolvedProblemsMap
  /** True while the initial resolved-state fetch is in flight — gate the
   * tree on it so resolved problems don't flash as unresolved. */
  resolvedLoading: boolean
  /** Keys with a resolve/unresolve currently in flight. Pending is PER KEY
   * (issue #159): resolving one problem must not lock every button on the
   * page, only its own — rapid multi-resolve workflows stay responsive. */
  pendingKeys: ReadonlySet<string>
  toggleFailed: boolean
  toggleResolved: (key: string, resolved: boolean) => void
  dismissToggleError: () => void
}

export function useProblemResolution(enabled: boolean): ProblemResolutionState {
  const queryClient = useQueryClient()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  // Failure is tracked in state, NOT via mutation.isError: all toggles share
  // one useMutation, whose isError reflects only the LATEST mutate() call —
  // under concurrent toggles (this hook's whole point), an earlier key's
  // failure would be silently masked by a later key's success.
  const [toggleFailed, setToggleFailed] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['resolved-problems'],
    queryFn: async () => parseResolvedProblemsResponse(await api.getResolvedProblems()),
    enabled,
    // Resolution state is shared across users, so keep it deliberately
    // fresh: refetch when the tab regains focus and treat it as stale
    // after 15s so another user's resolves appear without a remount.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })

  const mutation = useMutation({
    mutationFn: ({ key, resolved }: { key: string; resolved: boolean }) =>
      api.setProblemResolved(key, resolved),
    onMutate: ({ key }) => {
      setPendingKeys((prev) => new Set(prev).add(key))
    },
    onSettled: (_data, _error, { key }) => {
      setPendingKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    onError: () => {
      setToggleFailed(true)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  const toggleResolved = (key: string, resolved: boolean) => {
    // Per-key best-effort guard alongside the disabled button; the real
    // backstop for a same-key SET/REMOVE race is that each request is a
    // single atomic DynamoDB write — this just avoids firing an obviously
    // redundant request. Other keys stay toggleable (issue #159).
    if (pendingKeys.has(key)) return
    mutation.mutate({ key, resolved })
  }

  return {
    resolvedMap: data?.resolved ?? {},
    resolvedLoading: isLoading,
    pendingKeys,
    toggleFailed,
    toggleResolved,
    dismissToggleError: () => setToggleFailed(false),
  }
}
