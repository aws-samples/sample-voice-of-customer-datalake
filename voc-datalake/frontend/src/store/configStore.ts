import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'

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
  timeRange: '24h' | '48h' | '7d' | '30d' | 'custom'
  customDateRange: { start: string; end: string } | null
  setConfig: (config: Partial<Config>) => void
  setTimeRange: (range: '24h' | '48h' | '7d' | '30d' | 'custom') => void
  setCustomDateRange: (range: { start: string; end: string } | null) => void
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
    (set) => ({
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
      customDateRange: null,
      setConfig: (newConfig) => set((state) => ({ 
        config: { ...state.config, ...newConfig } 
      })),
      setTimeRange: (range) => set({ timeRange: range }),
      setCustomDateRange: (range) => set({ customDateRange: range }),
    }),
    { name: 'voc-config' }
  )
)
