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
import type { Config } from '../../store/configStore'

type SetConfig = (config: Partial<Config>) => void

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
 * - Drafts reset whenever a fresh, error-free brand-settings payload arrives.
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

  const usableSettings = backendSettings && !backendSettings.error ? backendSettings : undefined

  const [prevBackendSettings, setPrevBackendSettings] = useState<BrandSettingsResponse | undefined>(undefined)
  if (backendSettings !== prevBackendSettings) {
    setPrevBackendSettings(backendSettings)
    if (usableSettings) {
      setBrandName(usableSettings.brand_name ?? '')
      setBrandHandles((usableSettings.brand_handles ?? []).join(', '))
      setHashtags((usableSettings.hashtags ?? []).join(', '))
      setUrlsToTrack((usableSettings.urls_to_track ?? []).join('\n'))
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

  return {
    brandName, setBrandName,
    brandHandles, setBrandHandles,
    hashtags, setHashtags,
    urlsToTrack, setUrlsToTrack,
  }
}
