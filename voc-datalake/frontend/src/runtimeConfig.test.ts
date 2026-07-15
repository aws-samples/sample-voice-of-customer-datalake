/**
 * Tests for the runtime-config env fallback.
 *
 * Regression guard: when config.json is unavailable and the env config fails
 * schema validation (Cognito vars are usually absent in local development),
 * the fallback must keep a valid VITE_API_ENDPOINT instead of discarding it,
 * and otherwise point at the documented local mock port (3001), not the
 * previously hardcoded 3000 that nothing serves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('loadRuntimeConfig env fallback', () => {
  beforeEach(() => {
    // Reset the module-level config singleton between tests.
    vi.resetModules()
    // Silence expected warn/error noise from the fallback paths.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps a valid VITE_API_ENDPOINT when cognito vars are missing', async () => {
    vi.stubEnv('VITE_API_ENDPOINT', 'http://localhost:9999')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('config.json unavailable')))

    const { loadRuntimeConfig } = await import('./runtimeConfig')
    const config = await loadRuntimeConfig()

    expect(config.apiEndpoint).toBe('http://localhost:9999')
  })

  it('falls back to the documented mock port when no endpoint is configured', async () => {
    vi.stubEnv('VITE_API_ENDPOINT', '')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('config.json unavailable')))

    const { loadRuntimeConfig } = await import('./runtimeConfig')
    const config = await loadRuntimeConfig()

    expect(config.apiEndpoint).toBe('http://localhost:3001')
  })

  it('falls back to the documented mock port for a malformed endpoint', async () => {
    vi.stubEnv('VITE_API_ENDPOINT', 'not-a-url')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('config.json unavailable')))

    const { loadRuntimeConfig } = await import('./runtimeConfig')
    const config = await loadRuntimeConfig()

    expect(config.apiEndpoint).toBe('http://localhost:3001')
  })

  it('prefers a valid config.json over env vars', async () => {
    vi.stubEnv('VITE_API_ENDPOINT', 'http://localhost:9999')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        apiEndpoint: 'https://real-api.example.com',
        cognito: {
          userPoolId: 'us-east-1_pool',
          clientId: 'client123',
          region: 'us-east-1',
          identityPoolId: 'us-east-1:identity',
        },
      }),
    }))

    const { loadRuntimeConfig } = await import('./runtimeConfig')
    const config = await loadRuntimeConfig()

    expect(config.apiEndpoint).toBe('https://real-api.example.com')
  })
})


describe('isWebSearchAvailable', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const baseConfig = {
    apiEndpoint: 'https://real-api.example.com',
    cognito: {
      userPoolId: 'us-east-1_pool',
      clientId: 'client123',
      region: 'us-east-1',
      identityPoolId: 'us-east-1:identity',
    },
  }

  function stubConfigJson(config: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(config),
    }))
  }

  it('is false before the config loads', async () => {
    const { isWebSearchAvailable } = await import('./runtimeConfig')
    expect(isWebSearchAvailable()).toBe(false)
  })

  it('is true when the deployment reports the feature', async () => {
    stubConfigJson({ ...baseConfig, features: { webSearch: true } })

    const { loadRuntimeConfig, isWebSearchAvailable } = await import('./runtimeConfig')
    await loadRuntimeConfig()

    expect(isWebSearchAvailable()).toBe(true)
  })

  it('is false when the deployment reports webSearch: false', async () => {
    stubConfigJson({ ...baseConfig, features: { webSearch: false } })

    const { loadRuntimeConfig, isWebSearchAvailable } = await import('./runtimeConfig')
    await loadRuntimeConfig()

    expect(isWebSearchAvailable()).toBe(false)
  })

  it('is false for older config.json files without a features block', async () => {
    stubConfigJson(baseConfig)

    const { loadRuntimeConfig, isWebSearchAvailable } = await import('./runtimeConfig')
    await loadRuntimeConfig()

    expect(isWebSearchAvailable()).toBe(false)
  })

  it('honors VITE_ENABLE_WEB_SEARCH in the env fallback for local development', async () => {
    vi.stubEnv('VITE_API_ENDPOINT', 'http://localhost:9999')
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_pool')
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'client123')
    vi.stubEnv('VITE_IDENTITY_POOL_ID', 'us-east-1:identity')
    vi.stubEnv('VITE_ENABLE_WEB_SEARCH', 'true')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('config.json unavailable')))

    const { loadRuntimeConfig, isWebSearchAvailable } = await import('./runtimeConfig')
    await loadRuntimeConfig()

    expect(isWebSearchAvailable()).toBe(true)
  })
})
