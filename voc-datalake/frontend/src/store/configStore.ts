import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getEnvString } from '../lib/env'
import {
  getRuntimeConfig, isConfigLoaded,
} from '../runtimeConfig'

interface Config {
  apiEndpoint: string
  brandName: string
  brandHandles: string[]
  hashtags: string[]
  urlsToTrack: string[]
}

interface ConfigStore {
  config: Config
  timeRange: '24h' | '48h' | '7d' | '30d' | 'custom'
  customDateRange: {
    start: string;
    end: string
  } | null
  setConfig: (config: Partial<Config>) => void
  setTimeRange: (range: '24h' | '48h' | '7d' | '30d' | 'custom') => void
  setCustomDateRange: (range: {
    start: string;
    end: string
  } | null) => void
  syncWithRuntimeConfig: () => void
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
      },
      timeRange: '7d',
      customDateRange: null,
      setConfig: (newConfig) => set((state) => ({
        config: {
          ...state.config,
          ...newConfig,
        },
      })),
      setTimeRange: (range) => set({ timeRange: range }),
      setCustomDateRange: (range) => set({ customDateRange: range }),
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
          if (runtimeConfig.apiEndpoint !== '' && runtimeConfig.apiEndpoint !== currentConfig.apiEndpoint) {
            set((state) => ({
              config: {
                ...state.config,
                apiEndpoint: runtimeConfig.apiEndpoint,
              },
            }))
          }
        }
      },
    }),
    { name: 'voc-config' },
  ),
)
