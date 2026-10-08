/**
 * @fileoverview The caller's onboarding-buddy preference and start page:
 * server-backed, with a
 * per-user localStorage CACHE so Home does not flash the buddy and then hide it
 * while the GET is in flight.
 *
 * The cache is never the source of truth: it seeds the query as stale initial
 * data (refetched at once), the server answer always overwrites it, and a new
 * browser (empty cache) simply waits for the server. If the server cannot be
 * reached the cached answer stands, else the first-run default (shown).
 *
 * @module pages/Home/onboarding/useOnboardingPreference
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_ONBOARDING, normalizeOnboarding, onboardingApi, onboardingKey } from '../../../api/onboardingApi'
import { useAuthStore } from '../../../store/authStore'
import { useConfigStore } from '../../../store/configStore'
import type { OnboardingChanges, OnboardingPreference, OnboardingState, StartPage } from '../../../api/onboardingApi'

const CACHE_PREFIX = 'voc-onboarding:'

const cacheKeyFor = (sub: string | undefined) => `${CACHE_PREFIX}${sub ?? 'anonymous'}`

function readCachedOnboarding(sub: string | undefined): OnboardingPreference | undefined {
  try {
    const raw = window.localStorage.getItem(cacheKeyFor(sub))
    return raw === null ? undefined : normalizeOnboarding(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function writeCachedOnboarding(sub: string | undefined, value: OnboardingPreference): void {
  try {
    window.localStorage.setItem(cacheKeyFor(sub), JSON.stringify(value))
  } catch {
    // Storage full or blocked: the cache is optional.
  }
}

export interface OnboardingPreferenceResult {
  /** Server answer, else the cached one, else the first-run default. */
  preference: OnboardingPreference
  /** True until the server (or the cache) has answered — render nothing yet. */
  isResolving: boolean
  setState: (state: OnboardingState) => void
  setStartPage: (page: StartPage) => void
  isSaving: boolean
  saveFailed: boolean
}

export function useOnboardingPreference(): OnboardingPreferenceResult {
  const sub = useAuthStore().user?.sub
  const enabled = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const queryClient = useQueryClient()
  const queryKey = [...onboardingKey(), sub ?? ''] as const

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const fresh = await onboardingApi.get()
      writeCachedOnboarding(sub, fresh)
      return fresh
    },
    enabled,
    // Lazy: localStorage is read once per cache entry, not on every render.
    initialData: () => readCachedOnboarding(sub),
    // Stale at once: the cache only bridges the first paint.
    initialDataUpdatedAt: 0,
    retry: 1,
  })

  const mutation = useMutation({
    mutationFn: (changes: OnboardingChanges) => onboardingApi.save(changes),
    // Hook-level callbacks also run after the page unmounts (a "start on the
    // dashboard" choice is usually followed by leaving Home).
    onSuccess: (fresh) => {
      writeCachedOnboarding(sub, fresh)
      queryClient.setQueryData(queryKey, fresh)
    },
  })

  return {
    preference: query.data ?? DEFAULT_ONBOARDING,
    isResolving: enabled && query.data === undefined && query.isPending,
    setState: (state) => mutation.mutate({ state }),
    setStartPage: (page) => mutation.mutate({ start_page: page }),
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
  }
}
