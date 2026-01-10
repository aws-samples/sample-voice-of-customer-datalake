/**
 * @fileoverview Tests for configStore Zustand store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useConfigStore } from './configStore'

describe('configStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useConfigStore.setState({
      config: {
        apiEndpoint: '',
        artifactBuilderEndpoint: '',
        brandName: '',
        brandHandles: [],
        hashtags: [],
        urlsToTrack: [],
        sources: {
          trustpilot: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          yelp: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          google_reviews: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          twitter: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          instagram: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          facebook: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          reddit: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          tavily: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          appstore_apple: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          appstore_google: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          appstore_huawei: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          webscraper: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
        },
      },
      timeRange: '7d',
      customDateRange: null,
    })
  })

  describe('setConfig', () => {
    it('sets API endpoint correctly', () => {
      const { setConfig } = useConfigStore.getState()

      setConfig({ apiEndpoint: 'https://api.example.com' })

      const { config } = useConfigStore.getState()
      expect(config.apiEndpoint).toBe('https://api.example.com')
    })

    it('preserves existing config when updating partial config', () => {
      const { setConfig } = useConfigStore.getState()

      setConfig({ apiEndpoint: 'https://api.example.com', brandName: 'TestBrand' })
      setConfig({ brandName: 'UpdatedBrand' })

      const { config } = useConfigStore.getState()
      expect(config.apiEndpoint).toBe('https://api.example.com')
      expect(config.brandName).toBe('UpdatedBrand')
    })

    it('sets brand handles array', () => {
      const { setConfig } = useConfigStore.getState()

      setConfig({ brandHandles: ['@brand', '@company'] })

      const { config } = useConfigStore.getState()
      expect(config.brandHandles).toEqual(['@brand', '@company'])
    })
  })

  describe('setTimeRange', () => {
    it('sets time range to 24h', () => {
      const { setTimeRange } = useConfigStore.getState()

      setTimeRange('24h')

      const { timeRange } = useConfigStore.getState()
      expect(timeRange).toBe('24h')
    })

    it('sets time range to 30d', () => {
      const { setTimeRange } = useConfigStore.getState()

      setTimeRange('30d')

      const { timeRange } = useConfigStore.getState()
      expect(timeRange).toBe('30d')
    })

    it('sets time range to custom', () => {
      const { setTimeRange } = useConfigStore.getState()

      setTimeRange('custom')

      const { timeRange } = useConfigStore.getState()
      expect(timeRange).toBe('custom')
    })
  })

  describe('setCustomDateRange', () => {
    it('sets custom date range correctly', () => {
      const { setCustomDateRange, setTimeRange } = useConfigStore.getState()

      setTimeRange('custom')
      setCustomDateRange({ start: '2025-01-01', end: '2025-01-31' })

      const { customDateRange, timeRange } = useConfigStore.getState()
      expect(timeRange).toBe('custom')
      expect(customDateRange).toEqual({ start: '2025-01-01', end: '2025-01-31' })
    })

    it('clears custom date range when set to null', () => {
      const { setCustomDateRange } = useConfigStore.getState()

      setCustomDateRange({ start: '2025-01-01', end: '2025-01-31' })
      setCustomDateRange(null)

      const { customDateRange } = useConfigStore.getState()
      expect(customDateRange).toBeNull()
    })
  })
})
