import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'
import type { DateBasis } from '../api/types'

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
      setConfig: (newConfig) => set((state) => ({ 
        config: { ...state.config, ...newConfig } 
      })),
      setTimeRange: (range) => set({ timeRange: range }),
      setCustomDays: (days) => set({ customDays: days }),
      setDateBasis: (basis) => set({ dateBasis: basis }),
      /**
       * Syncs the store's apiEndpoint with the runtime config.
       * This ensures first-time users get the correct API endpoint
       * from the deployed config.json rather than relying on localStorage.
       */
      syncWithRuntimeConfig: () => {
        if (isConfigLoaded()) {
          const runtimeConfig = getRuntimeConfig()
          const currentConfig = get().config
          // Only update if runtime config has a valid endpoint and store doesn't
          // or if they differ (runtime config takes precedence)
          if (runtimeConfig.apiEndpoint && runtimeConfig.apiEndpoint !== currentConfig.apiEndpoint) {
            set((state) => ({
              config: { ...state.config, apiEndpoint: runtimeConfig.apiEndpoint }
            }))
          }
        }
      }
    }),
    { name: 'voc-config' }
  )
)
