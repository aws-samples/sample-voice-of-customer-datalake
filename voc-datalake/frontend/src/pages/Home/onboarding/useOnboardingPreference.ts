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
 * Closing a Home card (the subscribe prompt, an agent-decision card), picking a
 * role playbook and ticking one of its steps are applied to the cached answer at
 * once, so the screen answers the moment it is pressed; a failed save puts it back.
 *
 * @module pages/Home/onboarding/useOnboardingPreference
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_ONBOARDING, normalizeOnboarding, onboardingApi, onboardingKey } from '../../../api/onboardingApi'
import { useAuthStore } from '../../../store/authStore'
import { useConfigStore } from '../../../store/configStore'
import type { GuideState, OnboardingChanges, OnboardingPreference, OnboardingState, PlaybookRole, StartPage } from '../../../api/onboardingApi'

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

/** Whether a change is applied to the cached answer before the save (a closed card, the playbook and its ticks). */
const isOptimistic = (changes: OnboardingChanges) =>
  'subscribe_prompt' in changes || 'dismiss_decision_run' in changes || 'playbook' in changes || 'playbook_done' in changes

/** The preference with an optimistic change applied (other changes leave it as it is). */
function optimistic(current: OnboardingPreference, changes: OnboardingChanges): OnboardingPreference {
  if ('subscribe_prompt' in changes) return { ...current, subscribe_prompt: changes.subscribe_prompt }
  if ('dismiss_decision_run' in changes) {
    return { ...current, dismissed_decision_runs: [changes.dismiss_decision_run, ...current.dismissed_decision_runs] }
  }
  if ('playbook' in changes) return { ...current, playbook: changes.playbook }
  if ('playbook_done' in changes) return { ...current, playbook_done: [...changes.playbook_done] }
  return current
}

export interface OnboardingPreferenceResult {
  /** Server answer, else the cached one, else the first-run default. */
  preference: OnboardingPreference
  /** True until the server (or the cache) has answered — render nothing yet. */
  isResolving: boolean
  setState: (state: OnboardingState) => void
  setStartPage: (page: StartPage) => void
  /** Skip / reopen Home's "How it works" (stored per user, next to the checklist). */
  setGuide: (guide: GuideState) => void
  /** Close Home's "Subscribe to the morning brief" card (Account still subscribes). */
  dismissSubscribePrompt: () => void
  /** Close Home's decision card for this waiting run; a later waiting run shows again. */
  dismissDecisionRun: (runId: string) => void
  /** Pick (or, null, clear) the role playbook (docs/playbooks.md). */
  setPlaybook: (role: PlaybookRole | null) => void
  /** Replace the playbook steps ticked by hand. */
  setPlaybookDone: (steps: readonly string[]) => void
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
    onMutate: async (changes) => {
      // Nothing optimistic to write, so nothing to roll back on an error.
      if (!isOptimistic(changes)) return { previous: undefined }
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<OnboardingPreference>(queryKey)
      queryClient.setQueryData(queryKey, optimistic(previous ?? DEFAULT_ONBOARDING, changes))
      return { previous }
    },
    onError: (_error, _changes, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(queryKey, context.previous)
    },
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
    setGuide: (guide) => mutation.mutate({ guide }),
    dismissSubscribePrompt: () => mutation.mutate({ subscribe_prompt: 'dismissed' }),
    dismissDecisionRun: (runId) => mutation.mutate({ dismiss_decision_run: runId }),
    setPlaybook: (role) => mutation.mutate({ playbook: role }),
    setPlaybookDone: (steps) => mutation.mutate({ playbook_done: steps }),
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
  }
}
