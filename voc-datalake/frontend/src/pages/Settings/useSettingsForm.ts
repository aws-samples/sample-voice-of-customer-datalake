/**
 * @fileoverview Form-state hook for the Settings page.
 *
 * Owns the "user has edited this field" state for the Settings form and
 * derives the visible value as: user edit > server data > store/runtime fallback.
 *
 * This avoids syncing server data into local React state via useEffect, which
 * is a known React anti-pattern (see eslint rule react-hooks/set-state-in-effect),
 * and isolates the Settings component from the cyclomatic complexity of owning
 * 6 fields plus their derivation rules.
 *
 * @module pages/Settings/useSettingsForm
 */

import {
  useCallback, useMemo, useState,
} from 'react'
import {
  getRuntimeConfig, isConfigLoaded,
} from '../../runtimeConfig'

interface FormEdits {
  apiEndpoint?: string
  brandName?: string
  brandHandles?: string
  hashtags?: string
  urlsToTrack?: string
  primaryLanguage?: string
}

interface ServerBrand {
  brand_name: string
  brand_handles: string[]
  hashtags: string[]
  urls_to_track: string[]
}

interface ServerReview { primary_language: string }

interface StoreConfig {
  apiEndpoint: string
  brandName: string
  brandHandles: string[]
  hashtags: string[]
  urlsToTrack: string[]
}

interface UseSettingsFormOptions {
  serverBrand: ServerBrand | null
  reviewSettings: ServerReview | undefined
  storeConfig: StoreConfig
}

export interface SettingsFormValues {
  apiEndpoint: string
  brandName: string
  brandHandles: string
  hashtags: string
  urlsToTrack: string
  primaryLanguage: string
}

export interface SettingsFormApi {
  values: SettingsFormValues
  setApiEndpoint: (v: string) => void
  setBrandName: (v: string) => void
  setBrandHandles: (v: string) => void
  setHashtags: (v: string) => void
  setUrlsToTrack: (v: string) => void
  setPrimaryLanguage: (v: string) => void
  /** Drop all local edits so the freshly-fetched server data shows through. */
  clearEdits: () => void
  /** Override every field with empty values (used by the Danger Zone reset). */
  resetToEmpty: () => void
}

/** Initial value for the API endpoint input, preferring runtime config when loaded. */
function getInitialApiEndpoint(storeApiEndpoint: string): string {
  if (isConfigLoaded()) return getRuntimeConfig().apiEndpoint
  return storeApiEndpoint
}

export function useSettingsForm({
  serverBrand,
  reviewSettings,
  storeConfig,
}: UseSettingsFormOptions): SettingsFormApi {
  const [edits, setEdits] = useState<FormEdits>({})

  const setField = useCallback(
    <K extends keyof FormEdits>(key: K, value: FormEdits[K]) => {
      setEdits((prev) => ({
        ...prev,
        [key]: value,
      }))
    },
    [],
  )

  const setApiEndpoint = useCallback(
    (v: string) => {
      setField('apiEndpoint', v)
    },
    [setField],
  )
  const setBrandName = useCallback(
    (v: string) => {
      setField('brandName', v)
    },
    [setField],
  )
  const setBrandHandles = useCallback(
    (v: string) => {
      setField('brandHandles', v)
    },
    [setField],
  )
  const setHashtags = useCallback(
    (v: string) => {
      setField('hashtags', v)
    },
    [setField],
  )
  const setUrlsToTrack = useCallback(
    (v: string) => {
      setField('urlsToTrack', v)
    },
    [setField],
  )
  const setPrimaryLanguage = useCallback(
    (v: string) => {
      setField('primaryLanguage', v)
    },
    [setField],
  )

  const clearEdits = useCallback(() => {
    setEdits({})
  }, [])

  const resetToEmpty = useCallback(() => {
    setEdits({
      apiEndpoint: '',
      brandName: '',
      brandHandles: '',
      hashtags: '',
      urlsToTrack: '',
      primaryLanguage: 'en',
    })
  }, [])

  const values = useMemo<SettingsFormValues>(
    () => deriveValues(edits, serverBrand, reviewSettings, storeConfig),
    [edits, serverBrand, reviewSettings, storeConfig],
  )

  return {
    values,
    setApiEndpoint,
    setBrandName,
    setBrandHandles,
    setHashtags,
    setUrlsToTrack,
    setPrimaryLanguage,
    clearEdits,
    resetToEmpty,
  }
}

function deriveValues(
  edits: FormEdits,
  serverBrand: ServerBrand | null,
  reviewSettings: ServerReview | undefined,
  storeConfig: StoreConfig,
): SettingsFormValues {
  return {
    apiEndpoint: pickApiEndpoint(edits, storeConfig),
    brandName: pickBrandName(edits, serverBrand, storeConfig),
    brandHandles: pickBrandHandles(edits, serverBrand, storeConfig),
    hashtags: pickHashtags(edits, serverBrand, storeConfig),
    urlsToTrack: pickUrlsToTrack(edits, serverBrand, storeConfig),
    primaryLanguage: pickPrimaryLanguage(edits, reviewSettings),
  }
}

function pickApiEndpoint(edits: FormEdits, storeConfig: StoreConfig): string {
  return edits.apiEndpoint ?? getInitialApiEndpoint(storeConfig.apiEndpoint)
}

function pickBrandName(
  edits: FormEdits,
  serverBrand: ServerBrand | null,
  storeConfig: StoreConfig,
): string {
  return edits.brandName ?? serverBrand?.brand_name ?? storeConfig.brandName
}

function pickBrandHandles(
  edits: FormEdits,
  serverBrand: ServerBrand | null,
  storeConfig: StoreConfig,
): string {
  if (edits.brandHandles !== undefined) return edits.brandHandles
  return (serverBrand?.brand_handles ?? storeConfig.brandHandles).join(', ')
}

function pickHashtags(
  edits: FormEdits,
  serverBrand: ServerBrand | null,
  storeConfig: StoreConfig,
): string {
  if (edits.hashtags !== undefined) return edits.hashtags
  return (serverBrand?.hashtags ?? storeConfig.hashtags).join(', ')
}

function pickUrlsToTrack(
  edits: FormEdits,
  serverBrand: ServerBrand | null,
  storeConfig: StoreConfig,
): string {
  if (edits.urlsToTrack !== undefined) return edits.urlsToTrack
  return (serverBrand?.urls_to_track ?? storeConfig.urlsToTrack).join('\n')
}

function pickPrimaryLanguage(
  edits: FormEdits,
  reviewSettings: ServerReview | undefined,
): string {
  return edits.primaryLanguage ?? reviewSettings?.primary_language ?? 'en'
}
