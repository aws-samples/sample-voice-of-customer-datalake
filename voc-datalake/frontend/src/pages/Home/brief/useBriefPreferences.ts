/**
 * @fileoverview The caller's own brief preferences (GET/PUT /settings/my-briefing).
 *
 * Which language (docs/briefing.md): unless the reader chose a brief language
 * (`language_source: 'chosen'`), the brief follows the app. Refresh carries the
 * app's language to the server; for a SUBSCRIBED reader, whose scheduled brief
 * and email are built with nobody in front of the screen, this hook also moves a
 * `ui`-sourced stored language to the app's when they differ (one PUT of
 * `{language, language_source: 'ui'}`).
 * @module pages/Home/brief/useBriefPreferences
 */
import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { DEFAULT_PREFERENCES, briefPreferencesKey, briefingApi } from '../../../api/briefingApi'
import { isSupportedLanguage } from '../../../i18n/languages'
import type { SupportedLanguage } from '../../../i18n/languages'
import { useBriefScope } from './useBriefScope'
import type { BriefPreferenceChanges, BriefPreferences } from '../../../api/briefingApi'

export interface BriefPreferencesResult {
  preferences: BriefPreferences
  isLoading: boolean
  save: (changes: BriefPreferenceChanges) => void
  isSaving: boolean
  saveFailed: boolean
}

/** The language a subscribed, app-following brief should move to; null when none is due. */
function followAppLanguage(stored: BriefPreferences | undefined, appLanguage: string): SupportedLanguage | null {
  if (stored === undefined || !stored.enabled || stored.language_source !== 'ui') return null
  if (!isSupportedLanguage(appLanguage) || stored.language === appLanguage) return null
  return appLanguage
}

export function useBriefPreferences(): BriefPreferencesResult {
  const { sub, enabled, queryClient, appLanguage } = useBriefScope()
  const queryKey = [...briefPreferencesKey(), sub] as const
  const query = useQuery({ queryKey, queryFn: briefingApi.getPreferences, enabled })
  const mutation = useMutation({
    mutationFn: briefingApi.savePreferences,
    onSuccess: (fresh) => { queryClient.setQueryData(queryKey, fresh) },
  })
  const { mutate } = mutation
  const follow = followAppLanguage(query.data, appLanguage)
  // Keyed on the target language only: a successful PUT clears it, a failed one is not retried in a loop.
  useEffect(() => {
    if (follow !== null) mutate({ language: follow, language_source: 'ui' })
  }, [follow, mutate])
  return {
    preferences: query.data ?? DEFAULT_PREFERENCES,
    isLoading: query.isLoading,
    save: (changes) => { mutation.mutate(changes) },
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
  }
}
