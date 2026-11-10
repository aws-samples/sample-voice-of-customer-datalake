/**
 * @fileoverview State-sync hooks for the Settings page.
 * @module pages/Settings/useSettingsSync
 *
 * Extracted from Settings.tsx to keep the page component within the
 * complexity budget. Both hooks follow the React-recommended render-phase
 * adjustment pattern (setState during render behind a prev-value guard)
 * instead of synchronous setState inside effects; effects are reserved for
 * external-system writes (the persisted config store).
 */

import { useState, useEffect } from 'react'
import { getRuntimeConfig, isConfigLoaded } from '../../runtimeConfig'
import { rebaseDraft } from '../../components/UnsavedChangesGuard/rebaseDraft'
import type { Config } from '../../store/configStore'

type SetConfig = (config: Partial<Config>) => void

/** The brand form's four text fields, as the inputs hold them. */
interface BrandFields {
  readonly brandName: string
  readonly brandHandles: string
  readonly hashtags: string
  readonly urlsToTrack: string
}
const BRAND_FIELDS: ReadonlyArray<keyof BrandFields> = ['brandName', 'brandHandles', 'hashtags', 'urlsToTrack']

/** Brand settings payload returned by GET /settings/brand. */
export interface BrandSettingsResponse {
  brand_name?: string
  brand_handles?: string[]
  hashtags?: string[]
  urls_to_track?: string[]
  error?: string
}

/**
 * Owns the API-endpoint form field.
 *
 * - The field follows the persisted store value whenever it changes.
 * - On mount, a valid runtime config (config.json) endpoint is pushed into
 *   the persisted store; the field then follows via the render-phase sync.
 */
export function useApiEndpointField(storeEndpoint: string, setConfig: SetConfig) {
  const [apiEndpoint, setApiEndpoint] = useState(() => (
    isConfigLoaded() ? getRuntimeConfig().apiEndpoint : storeEndpoint
  ))

  const [prevStoreEndpoint, setPrevStoreEndpoint] = useState(storeEndpoint)
  if (prevStoreEndpoint !== storeEndpoint) {
    setPrevStoreEndpoint(storeEndpoint)
    setApiEndpoint(storeEndpoint)
  }

  useEffect(() => {
    if (isConfigLoaded()) {
      const runtimeConfig = getRuntimeConfig()
      if (runtimeConfig.apiEndpoint && runtimeConfig.apiEndpoint !== storeEndpoint) {
        setConfig({ apiEndpoint: runtimeConfig.apiEndpoint })
      }
    }
  }, [storeEndpoint, setConfig])

  return { apiEndpoint, setApiEndpoint }
}

/**
 * Owns the brand form drafts (name, handles, hashtags, URLs).
 *
 * - A fresh, error-free brand-settings payload re-bases the drafts: fields the
 *   user has not edited follow it, edited fields keep the edit (R2).
 * - The payload is mirrored into the persisted config store via an effect.
 */
export function useBrandForm(
  config: Config,
  setConfig: SetConfig,
  backendSettings: BrandSettingsResponse | undefined,
) {
  const [brandName, setBrandName] = useState(config.brandName)
  const [brandHandles, setBrandHandles] = useState(config.brandHandles.join(', '))
  const [hashtags, setHashtags] = useState(config.hashtags.join(', '))
  const [urlsToTrack, setUrlsToTrack] = useState(config.urlsToTrack.join('\n'))
  // What the fields held when last loaded or saved: the unsaved-changes guard's reference.
  const [baseline, setBaseline] = useState<BrandFields>(() => ({
    brandName: config.brandName,
    brandHandles: config.brandHandles.join(', '),
    hashtags: config.hashtags.join(', '),
    urlsToTrack: config.urlsToTrack.join('\n'),
  }))

  const usableSettings = backendSettings && !backendSettings.error ? backendSettings : undefined

  const current: BrandFields = { brandName, brandHandles, hashtags, urlsToTrack }

  const [prevBackendSettings, setPrevBackendSettings] = useState<BrandSettingsResponse | undefined>(undefined)
  if (backendSettings !== prevBackendSettings) {
    setPrevBackendSettings(backendSettings)
    if (usableSettings) {
      const loaded: BrandFields = {
        brandName: usableSettings.brand_name ?? '',
        brandHandles: (usableSettings.brand_handles ?? []).join(', '),
        hashtags: (usableSettings.hashtags ?? []).join(', '),
        urlsToTrack: (usableSettings.urls_to_track ?? []).join('\n'),
      }
      // Re-base, never replace: the load (or a refetch) can land after the
      // user typed, e.g. while the unsaved-changes dialog is open (R2).
      const next = rebaseDraft(baseline, loaded, current, BRAND_FIELDS)
      setBrandName(next.brandName)
      setBrandHandles(next.brandHandles)
      setHashtags(next.hashtags)
      setUrlsToTrack(next.urlsToTrack)
      setBaseline(loaded)
    }
  }

  useEffect(() => {
    if (!backendSettings || backendSettings.error) return

    setConfig({
      brandName: backendSettings.brand_name ?? '',
      brandHandles: backendSettings.brand_handles ?? [],
      hashtags: backendSettings.hashtags ?? [],
      urlsToTrack: backendSettings.urls_to_track ?? [],
    })
  }, [backendSettings, setConfig])

  const dirty = BRAND_FIELDS.some((field) => current[field] !== baseline[field])

  return {
    brandName, setBrandName,
    brandHandles, setBrandHandles,
    hashtags, setHashtags,
    urlsToTrack, setUrlsToTrack,
    /** The fields differ from what was last loaded or saved (E2E F6). */
    dirty,
    /** After a successful save: the current values become the reference. */
    markSaved: () => setBaseline(current),
    /** Put every field back to what was last loaded or saved. */
    discard: () => {
      setBrandName(baseline.brandName)
      setBrandHandles(baseline.brandHandles)
      setHashtags(baseline.hashtags)
      setUrlsToTrack(baseline.urlsToTrack)
    },
  }
}
