/**
 * @fileoverview `vi.mock` factories for the modules the API clients read at
 * import time: the config store (API endpoint), the runtime config and the
 * Cognito auth service.
 *
 * `vi.mock` is hoisted above imports, so a spec reaches these through a
 * dynamic import inside the factory:
 *
 * ```ts
 * vi.mock('../store/configStore', () => import('@test/api-mocks').then(m => m.configStoreMock(API)))
 * vi.mock('../runtimeConfig', () => import('@test/api-mocks').then(m => m.runtimeConfigMock(API)))
 * vi.mock('../services/auth', () => import('@test/api-mocks').then(m => m.authServiceMock()))
 * ```
 */
import { vi } from 'vitest'

export const MOCK_ID_TOKEN = 'mock-id-token'

/**
 * `useConfigStore.getState()` answering the given endpoint (and `extra` state).
 * Every call returns the SAME state object, so a spec can change a field for
 * the reads that follow with `Object.assign(useConfigStore.getState(), {...})`.
 */
export function configStoreMock(apiEndpoint: string, extra: Record<string, unknown> = {}) {
  const state = { config: { apiEndpoint }, ...extra }
  return {
    useConfigStore: {
      getState: vi.fn(() => state),
    },
  }
}

/** A loaded runtime config pointing at `apiEndpoint` with a complete Cognito block. */
export function runtimeConfigMock(apiEndpoint: string) {
  return {
    isConfigLoaded: vi.fn(() => true),
    getRuntimeConfig: vi.fn(() => ({
      apiEndpoint,
      cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
    })),
  }
}

/** A configured auth service that hands out `idToken` (default {@link MOCK_ID_TOKEN}). */
export function authServiceMock(idToken: string = MOCK_ID_TOKEN) {
  return {
    authService: {
      isConfigured: vi.fn(() => true),
      getIdToken: vi.fn(() => idToken),
      getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
      refreshSession: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn(),
    },
  }
}

/**
 * Re-point an already-mocked `../runtimeConfig` module at `apiEndpoint`, loaded.
 * Pass the module namespace the spec imported (so the mocks it patches are the
 * ones the code under test resolves).
 */
export function loadRuntimeConfig(
  mod: typeof import('../runtimeConfig'),
  apiEndpoint: string,
): void {
  vi.mocked(mod.isConfigLoaded).mockReturnValue(true)
  vi.mocked(mod.getRuntimeConfig).mockReturnValue({
    apiEndpoint,
    cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
  })
}
