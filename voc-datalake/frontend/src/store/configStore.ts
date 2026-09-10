import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'
import { isTrustedApiEndpoint } from '../lib/trustedOrigins'
import type { DateBasis } from '../api/types'

/**
 * Return true when `endpoint` is safe to persist as the API endpoint.
 *
 * Delegates to {@link isTrustedApiEndpoint} from `lib/trustedOrigins` — the
 * single authoritative implementation shared with `api/baseUrl.ts`.
 *
 * An empty string is always safe (the "not configured" sentinel that falls
 * back to the `/api` relative-URL path in `getBaseUrl()`).
 */
const isAllowedApiEndpoint = isTrustedApiEndpoint

/** Return a copy of `obj` with `key` removed (avoids unused-variable lints). */
function omitKey<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj }
  delete copy[key]
  return copy
}

export interface SourceConfig {
  enabled: boolean
  schedule: string // cron or rate
  credentials: Record<string, string>
}

export interface Config {
  apiEndpoint: string
  brandName: string
  brandHandles: string[]
  hashtags: string[]
  urlsToTrack: string[]
  sources: {
    webscraper: SourceConfig
  }
}

interface ConfigStore {
  config: Config
  timeRange: '24h' | '48h' | '7d' | '30d' | 'custom' | 'all'
  /** Rolling lookback (in days) used when timeRange is 'custom'. */
  customDays: number | null
  /**
   * Which date the time range filters on: 'imported' (when the data entered
   * the lake — historical default) or 'review' (when the customer wrote it).
   */
  dateBasis: DateBasis
  setConfig: (config: Partial<Config>) => void
  setTimeRange: (range: '24h' | '48h' | '7d' | '30d' | 'custom' | 'all') => void
  setCustomDays: (days: number | null) => void
  setDateBasis: (basis: DateBasis) => void
  syncWithRuntimeConfig: () => void
}

const defaultSourceConfig: SourceConfig = {
  enabled: false,
  schedule: 'rate(5 minutes)',
  credentials: {}
}

function getEnvString(key: string, defaultValue = ''): string {
  const value: unknown = import.meta.env[key]
  return typeof value === 'string' ? value : defaultValue
}

// Get runtime config values, with fallbacks for when config isn't loaded yet
function getApiEndpoint(): string {
  if (isConfigLoaded()) {
    const cfg = getRuntimeConfig()
    return cfg.apiEndpoint
  }
  return getEnvString('VITE_API_ENDPOINT')
}

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set, get) => ({
      config: {
        apiEndpoint: getApiEndpoint(),
        brandName: '',
        brandHandles: [],
        hashtags: [],
        urlsToTrack: [],
        sources: {
          webscraper: { ...defaultSourceConfig },
        }
      },
      timeRange: '7d',
      customDays: null,
      dateBasis: 'imported',
      setConfig: (newConfig) => {
        // If an apiEndpoint is supplied, validate it at the store boundary.
        // An out-of-allowlist value is discarded so the store never holds a
        // value that would cause a token to be sent to a foreign host.
        if (newConfig.apiEndpoint !== undefined && !isAllowedApiEndpoint(newConfig.apiEndpoint)) {
          if (import.meta.env.DEV) {
            // Surface the rejection during development so engineers know why
            // their typed value was not persisted. Vite tree-shakes this branch
            // in production builds, so it never reaches end-users.
            console.warn(
              '[configStore] setConfig: apiEndpoint rejected — not in the trusted-origin allowlist:',
              newConfig.apiEndpoint,
            )
          }
          const safeFields = omitKey(newConfig, 'apiEndpoint')
          if (Object.keys(safeFields).length > 0) {
            set((state) => ({ config: { ...state.config, ...safeFields } }))
          }
          return
        }
        set((state) => ({ config: { ...state.config, ...newConfig } }))
      },
      setTimeRange: (range) => set({ timeRange: range }),
      setCustomDays: (days) => set({ customDays: days }),
      setDateBasis: (basis) => set({ dateBasis: basis }),
      /**
       * Syncs the store's apiEndpoint with the runtime config.
       *
       * This ensures first-time users get the correct API endpoint from the
       * deployed config.json rather than relying on localStorage.
       *
       * It also handles the "stale persisted value" case: if a user already
       * has an out-of-allowlist value saved (e.g. from a build that lacked this
       * validation), that value is overwritten with the authoritative runtime
       * config endpoint so no further requests are made to the foreign host.
       */
      syncWithRuntimeConfig: () => {
        if (isConfigLoaded()) {
          const runtimeConfig = getRuntimeConfig()
          const currentConfig = get().config

          // Always override if the currently stored endpoint is not in the
          // allowlist — this is the key defence against already-persisted bad
          // values. Also override when the runtime config has a different
          // valid endpoint (first-time deployment, environment change, etc.).
          const runtimeEndpoint = runtimeConfig.apiEndpoint ?? ''
          const storedIsAllowed = isAllowedApiEndpoint(currentConfig.apiEndpoint)
          const needsUpdate: boolean = !storedIsAllowed || (
            runtimeEndpoint !== '' && runtimeEndpoint !== currentConfig.apiEndpoint
          )

          if (needsUpdate) {
            set((state) => ({
              config: { ...state.config, apiEndpoint: runtimeEndpoint }
            }))
          }
        }
      }
    }),
    { name: 'voc-config' }
  )
)
