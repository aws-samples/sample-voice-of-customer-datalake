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

/**
 * A fresh `./runtimeConfig` module per test (it holds the loaded config in a
 * module-level singleton), with the fallback paths' expected console noise
 * silenced and every env/global stub undone afterwards.
 */
function useFreshRuntimeConfigModule(): void {
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
}

describe('loadRuntimeConfig env fallback', () => {
  useFreshRuntimeConfigModule()

  it.each([
    ['keeps a valid VITE_API_ENDPOINT when cognito vars are missing', 'http://localhost:9999', 'http://localhost:9999'],
    ['falls back to the documented mock port when no endpoint is configured', '', 'http://localhost:3001'],
    ['falls back to the documented mock port for a malformed endpoint', 'not-a-url', 'http://localhost:3001'],
  ])('%s', async (_title, envEndpoint, expected) => {
    vi.stubEnv('VITE_API_ENDPOINT', envEndpoint)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('config.json unavailable')))

    const { loadRuntimeConfig } = await import('./runtimeConfig')
    const config = await loadRuntimeConfig()

    expect(config.apiEndpoint).toBe(expected)
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
  useFreshRuntimeConfigModule()

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

  it('keeps the flag on the mock-only path (no Cognito vars at all)', async () => {
    // Regression: the invalid-env fallback (the branch that ALWAYS runs in
    // mock-only dev) rebuilt the config without the features block, so the
    // escape hatch never worked in the very environment it exists for.
    vi.stubEnv('VITE_ENABLE_WEB_SEARCH', 'true')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('config.json unavailable')))

    const { loadRuntimeConfig, isWebSearchAvailable } = await import('./runtimeConfig')
    const config = await loadRuntimeConfig()

    expect(config.apiEndpoint).toBe('http://localhost:3001')
    expect(isWebSearchAvailable()).toBe(true)
  })
})
