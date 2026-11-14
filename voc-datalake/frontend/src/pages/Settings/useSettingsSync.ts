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
import type { BrandSettingsPayload, BrandSettingsResponse } from '../../api/brandApi'

type SetConfig = (config: Partial<Config>) => void

/** The brand form's four text fields, as the inputs hold them. */
export interface BrandFields {
  readonly brandName: string
  readonly brandHandles: string
  readonly hashtags: string
  readonly urlsToTrack: string
}
const BRAND_FIELDS: ReadonlyArray<keyof BrandFields> = ['brandName', 'brandHandles', 'hashtags', 'urlsToTrack']


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

/** The brand as `PUT /settings/brand` takes it, from the form's text fields (lists split, trimmed, blanks dropped). */
export function brandPayload(fields: BrandFields): BrandSettingsPayload {
  const list = (input: string, separator: string): string[] => input.split(separator).map((s) => s.trim()).filter(Boolean)
  return {
    brand_name: fields.brandName,
    brand_handles: list(fields.brandHandles, ','),
    hashtags: list(fields.hashtags, ','),
    urls_to_track: list(fields.urlsToTrack, '\n'),
  }
}

/** A stored brand as the form's text fields. */
function fieldsOf(settings: BrandSettingsResponse): BrandFields {
  return {
    brandName: settings.brand_name ?? '',
    brandHandles: (settings.brand_handles ?? []).join(', '),
    hashtags: (settings.hashtags ?? []).join(', '),
    urlsToTrack: (settings.urls_to_track ?? []).join('\n'),
  }
}

/** The four fields empty: before the first load of a brand that is not kept in this browser. */
export const EMPTY_BRAND_FIELDS: BrandFields = { brandName: '', brandHandles: '', hashtags: '', urlsToTrack: '' }

/**
 * Owns the brand form drafts (name, handles, hashtags, URLs), starting from `initial`.
 *
 * A fresh, error-free brand-settings payload re-bases the drafts: fields the user has not edited follow it, edited
 * fields keep the edit (R2). It writes nothing anywhere: the platform console's editor of the deployment's default
 * brand uses it alone, so the browser's saved brand (a workspace's, inside one) never takes the deployment's.
 */
export function useBrandDraft(initial: BrandFields, backendSettings: BrandSettingsResponse | undefined) {
  const [brandName, setBrandName] = useState(initial.brandName)
  const [brandHandles, setBrandHandles] = useState(initial.brandHandles)
  const [hashtags, setHashtags] = useState(initial.hashtags)
  const [urlsToTrack, setUrlsToTrack] = useState(initial.urlsToTrack)
  // What the fields held when last loaded or saved: the unsaved-changes guard's reference.
  const [baseline, setBaseline] = useState<BrandFields>(initial)

  const current: BrandFields = { brandName, brandHandles, hashtags, urlsToTrack }

  const [prevBackendSettings, setPrevBackendSettings] = useState<BrandSettingsResponse | undefined>(undefined)
  if (backendSettings !== prevBackendSettings) {
    setPrevBackendSettings(backendSettings)
    if (backendSettings && !backendSettings.error) {
      const loaded = fieldsOf(backendSettings)
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

  const dirty = BRAND_FIELDS.some((field) => current[field] !== baseline[field])

  return {
    brandName, setBrandName,
    brandHandles, setBrandHandles,
    hashtags, setHashtags,
    urlsToTrack, setUrlsToTrack,
    /** The four fields as they are now. */
    fields: current,
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

/**
 * The brand form of a page that also keeps the brand in this browser's config store (Administration → General, and
 * a workspace's settings page, whose config store is the workspace's own, workspace/workspaceStorage.ts): the drafts
 * of {@link useBrandDraft}, starting from the store, and the payload mirrored into the store via an effect.
 */
export function useBrandForm(
  config: Config,
  setConfig: SetConfig,
  backendSettings: BrandSettingsResponse | undefined,
) {
  const draft = useBrandDraft({
    brandName: config.brandName,
    brandHandles: config.brandHandles.join(', '),
    hashtags: config.hashtags.join(', '),
    urlsToTrack: config.urlsToTrack.join('\n'),
  }, backendSettings)

  useEffect(() => {
    if (!backendSettings || backendSettings.error) return

    setConfig({
      brandName: backendSettings.brand_name ?? '',
      brandHandles: backendSettings.brand_handles ?? [],
      hashtags: backendSettings.hashtags ?? [],
      urlsToTrack: backendSettings.urls_to_track ?? [],
    })
  }, [backendSettings, setConfig])

  return draft
}
