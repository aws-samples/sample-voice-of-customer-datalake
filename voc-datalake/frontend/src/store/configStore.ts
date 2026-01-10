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
  artifactBuilderEndpoint: string
  brandName: string
  brandHandles: string[]
  hashtags: string[]
  urlsToTrack: string[]
  sources: {
    trustpilot: SourceConfig
    yelp: SourceConfig
    google_reviews: SourceConfig
    twitter: SourceConfig
    instagram: SourceConfig
    facebook: SourceConfig
    reddit: SourceConfig
    tavily: SourceConfig
    appstore_apple: SourceConfig
    appstore_google: SourceConfig
    appstore_huawei: SourceConfig
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

// Get runtime config values, with fallbacks for when config isn't loaded yet
function getApiEndpoint(): string {
  if (isConfigLoaded()) {
    return getRuntimeConfig().apiEndpoint
  }
  return import.meta.env.VITE_API_ENDPOINT || ''
}

function getArtifactBuilderEndpoint(): string {
  if (isConfigLoaded()) {
    return getRuntimeConfig().artifactBuilderEndpoint
  }
  return import.meta.env.VITE_ARTIFACT_BUILDER_ENDPOINT || ''
}

export const useConfigStore = create<ConfigStore>()(
  persist(
    (set) => ({
      config: {
        apiEndpoint: getApiEndpoint(),
        artifactBuilderEndpoint: getArtifactBuilderEndpoint(),
        brandName: '',
        brandHandles: [],
        hashtags: [],
        urlsToTrack: [],
        sources: {
          trustpilot: { ...defaultSourceConfig },
          yelp: { ...defaultSourceConfig },
          google_reviews: { ...defaultSourceConfig },
          twitter: { ...defaultSourceConfig },
          instagram: { ...defaultSourceConfig },
          facebook: { ...defaultSourceConfig },
          reddit: { ...defaultSourceConfig },
          tavily: { ...defaultSourceConfig },
          appstore_apple: { ...defaultSourceConfig },
          appstore_google: { ...defaultSourceConfig },
          appstore_huawei: { ...defaultSourceConfig },
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
