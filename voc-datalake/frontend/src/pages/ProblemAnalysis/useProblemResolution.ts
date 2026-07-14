/**
 * @fileoverview Hook owning the shared problem-resolution state (issue #66).
 *
 * Wraps the resolved-problems query (deliberate freshness policy for shared
 * state) and the resolve/unresolve mutation, keeping the query/mutation
 * wiring out of the page component's complexity budget — same convention as
 * Settings' useSettingsSync.
 * @module pages/ProblemAnalysis/useProblemResolution
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { parseResolvedProblemsResponse } from './problemResolution'
import type { ResolvedProblemsMap } from './problemResolution'

interface ProblemResolutionState {
  resolvedMap: ResolvedProblemsMap
  /** True while the initial resolved-state fetch is in flight — gate the
   * tree on it so resolved problems don't flash as unresolved. */
  resolvedLoading: boolean
  togglePending: boolean
  toggleFailed: boolean
  toggleResolved: (key: string, resolved: boolean) => void
  dismissToggleError: () => void
}

export function useProblemResolution(enabled: boolean): ProblemResolutionState {
  const queryClient = useQueryClient()

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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  const toggleResolved = (key: string, resolved: boolean) => {
    // Double defense with the disabled buttons: covers the render gap before
    // the disabled state paints, so a rapid double-click can't race
    // SET/REMOVE for the same key server-side.
    if (mutation.isPending) return
    mutation.mutate({ key, resolved })
  }

  return {
    resolvedMap: data?.resolved ?? {},
    resolvedLoading: isLoading,
    togglePending: mutation.isPending,
    toggleFailed: mutation.isError,
    toggleResolved,
    dismissToggleError: () => mutation.reset(),
  }
}
