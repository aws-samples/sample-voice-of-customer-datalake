/**
 * @fileoverview Tests for configStore Zustand store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useConfigStore } from './configStore'
import * as runtimeConfig from '../runtimeConfig'

// Mock the runtimeConfig module
vi.mock('../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => false),
  getRuntimeConfig: vi.fn(() => ({
    apiEndpoint: 'https://runtime-api.example.com',
    cognito: { userPoolId: 'pool-123', clientId: 'client-123', region: 'us-east-1' }
  }))
}))

describe('configStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useConfigStore.setState({
      config: {
        apiEndpoint: '',
        brandName: '',
        brandHandles: [],
        hashtags: [],
        urlsToTrack: [],
        sources: {
          webscraper: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          manual_import: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
          s3_import: { enabled: false, schedule: 'rate(5 minutes)', credentials: {} },
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

  describe('syncWithRuntimeConfig', () => {
    it('updates apiEndpoint from runtime config when config is loaded', () => {
      // Mock isConfigLoaded to return true
      vi.mocked(runtimeConfig.isConfigLoaded).mockReturnValue(true)
      vi.mocked(runtimeConfig.getRuntimeConfig).mockReturnValue({
        apiEndpoint: 'https://runtime-api.example.com',
        cognito: { userPoolId: 'pool-123', clientId: 'client-123', region: 'us-east-1' }
      })

      const { syncWithRuntimeConfig } = useConfigStore.getState()
      syncWithRuntimeConfig()

      const { config } = useConfigStore.getState()
      expect(config.apiEndpoint).toBe('https://runtime-api.example.com')
    })

    it('does not update apiEndpoint when runtime config is not loaded', () => {
      vi.mocked(runtimeConfig.isConfigLoaded).mockReturnValue(false)

      const { syncWithRuntimeConfig, setConfig } = useConfigStore.getState()
      setConfig({ apiEndpoint: 'https://local-api.example.com' })
      syncWithRuntimeConfig()

      const { config } = useConfigStore.getState()
      expect(config.apiEndpoint).toBe('https://local-api.example.com')
    })

    it('does not update when runtime endpoint matches store endpoint', () => {
      vi.mocked(runtimeConfig.isConfigLoaded).mockReturnValue(true)
      vi.mocked(runtimeConfig.getRuntimeConfig).mockReturnValue({
        apiEndpoint: 'https://same-api.example.com',
        cognito: { userPoolId: 'pool-123', clientId: 'client-123', region: 'us-east-1' }
      })

      const { syncWithRuntimeConfig, setConfig } = useConfigStore.getState()
      setConfig({ apiEndpoint: 'https://same-api.example.com' })
      
      const setStateSpy = vi.spyOn(useConfigStore, 'setState')
      syncWithRuntimeConfig()

      // setState should not be called since endpoints match
      expect(setStateSpy).not.toHaveBeenCalled()
      setStateSpy.mockRestore()
    })
  })
})
