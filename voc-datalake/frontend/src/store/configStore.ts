import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'
import { getEnvString } from '../lib/env'
import { isTrustedApiEndpoint } from '../lib/trustedOrigins'
import type { DateBasis } from '../api/types'
import { versionedPersist } from './persistVersion'

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

interface SourceConfig {
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
  timeRange: typeof TIME_RANGES[number]
  /** Rolling lookback (in days) used when timeRange is 'custom'. */
  customDays: number | null
  /**
   * Which date the time range filters on: 'imported' (when the data entered
   * the lake — historical default) or 'review' (when the customer wrote it).
   */
  dateBasis: DateBasis
  setConfig: (config: Partial<Config>) => void
  setTimeRange: (range: typeof TIME_RANGES[number]) => void
  setCustomDays: (days: number | null) => void
  setDateBasis: (basis: DateBasis) => void
  syncWithRuntimeConfig: () => void
}

const defaultSourceConfig: SourceConfig = {
  enabled: false,
  schedule: 'rate(5 minutes)',
  credentials: {}
}

/**
 * Time-range tokens. `'90d'` is the widest fixed preset; `'all'` is ALL TIME
 * (days=0). Before persisted version 2, `'all'` was the token of the "90 Days"
 * preset — {@link upgradeConfigBlob} keeps those users on 90 days.
 */
const TIME_RANGES = ['24h', '48h', '7d', '30d', '90d', 'custom', 'all'] as const

/** Persisted version of 'voc-config': 2 = `'all'` means all time (was the 90-day preset). */
const CONFIG_PERSIST_VERSION = 2

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rewrite a pre-v2 'voc-config' blob: its `'all'` meant the "90 Days" preset,
 * so it becomes `'90d'` — the window the user actually picked — instead of
 * silently widening to all time. Total: anything else passes through unchanged.
 */
function upgradeConfigBlob(persisted: unknown, fromVersion: number): unknown {
  if (fromVersion >= CONFIG_PERSIST_VERSION || !isPlainRecord(persisted)) return persisted
  return persisted['timeRange'] === 'all' ? { ...persisted, timeRange: '90d' } : persisted
}

/** The persisted part of the store ('voc-config'), validated on rehydrate. */
const PersistedConfigSchema = z.object({
  config: z.object({
    apiEndpoint: z.string(),
    brandName: z.string(),
    brandHandles: z.array(z.string()),
    hashtags: z.array(z.string()),
    urlsToTrack: z.array(z.string()),
    sources: z.object({
      webscraper: z.object({
        enabled: z.boolean(),
        schedule: z.string(),
        credentials: z.record(z.string(), z.string()),
      }),
    }),
  }),
  timeRange: z.enum(TIME_RANGES),
  customDays: z.number().nullable(),
  dateBasis: z.enum(['imported', 'review']),
}).partial()

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
          // Schema-validated (`RuntimeConfigSchema`), so always a string.
          const runtimeEndpoint = runtimeConfig.apiEndpoint
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
    {
      name: 'voc-config',
      // The data fields only — exactly what was persisted before (functions
      // never serialise), now named so the shape can be versioned.
      partialize: (state): z.infer<typeof PersistedConfigSchema> => ({
        config: state.config,
        timeRange: state.timeRange,
        customDays: state.customDays,
        dateBasis: state.dateBasis,
      }),
      ...versionedPersist(PersistedConfigSchema, {
        version: CONFIG_PERSIST_VERSION,
        upgrade: upgradeConfigBlob,
      }),
    }
  )
)
