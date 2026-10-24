/**
 * @fileoverview The caller's newest brief, Refresh and card states (docs/briefing.md).
 *
 * While a build runs (`status: pending`) the brief is polled; the cards already
 * there stay on screen meanwhile. Refresh answers `up_to_date` at once when no
 * review arrived and the brief is younger than 15 minutes (the server's debounce).
 * Refresh sends the app's language: the brief follows it unless the reader chose a
 * brief language (docs/briefing.md → "Which language").
 *
 * @module pages/Home/brief/useBrief
 */
import { useCallback } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { NO_BRIEF, briefKey, briefPreferencesKey, briefingApi } from '../../../api/briefingApi'
import { useBriefScope } from './useBriefScope'
import type { Brief, CardState } from '../../../api/briefingApi'

/** How often a running build is polled. */
const BRIEF_POLL_MS = 3000

export type RefreshOutcome = 'idle' | 'up_to_date' | 'started' | 'failed'

export interface BriefResult {
  brief: Brief
  generating: boolean
  refresh: () => void
  refreshOutcome: RefreshOutcome
  setCardStates: (states: Record<string, CardState>) => void
}

function refreshOutcomeOf(isError: boolean, status: 'up_to_date' | 'pending' | undefined): RefreshOutcome {
  if (isError) return 'failed'
  if (status === 'up_to_date') return 'up_to_date'
  return status === 'pending' ? 'started' : 'idle'
}

/** A build in progress on a new day has no cards yet: keep showing the previous ones meanwhile. */
export function keepCards(previous: Brief | undefined, fresh: Brief): Brief {
  if (fresh.status !== 'pending' || fresh.cards.length > 0 || previous === undefined) return fresh
  return { ...previous, status: 'pending', requested_at: fresh.requested_at }
}

export function useBrief(): BriefResult {
  const { sub, enabled, queryClient, appLanguage } = useBriefScope()
  const queryKey = [...briefKey(), sub] as const

  const query = useQuery({
    queryKey,
    queryFn: async () => keepCards(queryClient.getQueryData<Brief>(queryKey), await briefingApi.getBrief()),
    enabled,
    refetchInterval: (current) => (current.state.data?.status === 'pending' ? BRIEF_POLL_MS : false),
  })
  const brief = query.data ?? NO_BRIEF

  const refresh = useMutation({
    mutationFn: (uiLanguage: string) => briefingApi.refresh(uiLanguage),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, keepCards(queryClient.getQueryData<Brief>(queryKey), result.brief))
      // The server may have moved a `ui`-sourced brief language to the app's: re-read the preferences only.
      void queryClient.invalidateQueries({ queryKey: [...briefPreferencesKey(), sub], exact: true })
    },
  })

  const cardStates = useMutation({
    mutationFn: (states: Record<string, CardState>) => briefingApi.setCardStates(brief.day ?? '', states),
    onMutate: (states) => {
      queryClient.setQueryData(queryKey, (old: Brief | undefined) =>
        old === undefined ? old : { ...old, card_state: { ...old.card_state, ...states } })
    },
  })

  const { mutate: saveCardStates } = cardStates
  const hasDay = brief.day !== undefined
  // Stable between renders, so the "mark seen" effect runs once per new set of cards.
  const setCardStates = useCallback((states: Record<string, CardState>) => {
    if (hasDay && Object.keys(states).length > 0) saveCardStates(states)
  }, [hasDay, saveCardStates])

  return {
    brief,
    generating: brief.status === 'pending' || refresh.isPending,
    // The brief is written in the language the reader uses the app in, unless they chose one.
    refresh: () => { refresh.mutate(appLanguage) },
    refreshOutcome: refreshOutcomeOf(refresh.isError, refresh.data?.status),
    setCardStates,
  }
}
