/**
 * @fileoverview Tests for authStore Zustand store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { z } from 'zod'
import { useAuthStore, useIsAdmin } from './authStore'
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'

/** Validates the persisted envelope at the boundary instead of asserting a type. */
const PersistedAuthSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  version: z.number().optional(),
})

// useIsAdmin reads the runtime config directly (services/auth imports this
// store, so importing authService here would be a cycle) — mock the module
// so each test controls whether Cognito is "configured".
vi.mock('../runtimeConfig', () => ({
  getRuntimeConfig: vi.fn(),
  isConfigLoaded: vi.fn(),
}))

const mockGetRuntimeConfig = vi.mocked(getRuntimeConfig)
const mockIsConfigLoaded = vi.mocked(isConfigLoaded)

function stubCognito(configured: boolean) {
  mockIsConfigLoaded.mockReturnValue(true)
  mockGetRuntimeConfig.mockReturnValue({
    apiEndpoint: 'https://api.example.com',
    cognito: configured
      ? { userPoolId: 'us-east-1_abc', clientId: 'client-123', region: 'us-east-1', identityPoolId: 'pool-1' }
      : { userPoolId: '', clientId: '', region: '', identityPoolId: '' },
  })
}

describe('authStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAuthStore.getState().logout()
  })

  describe('setUser', () => {
    it('sets user and marks as authenticated', () => {
      const { setUser } = useAuthStore.getState()
      const user = {
        username: 'testuser',
        email: 'test@example.com',
        groups: ['admins'],
      }

      setUser(user)

      const state = useAuthStore.getState()
      expect(state.user).toStrictEqual(user)
      expect(state.isAuthenticated).toBe(true)
    })

    it('clears user when set to null', () => {
      const { setUser } = useAuthStore.getState()

      setUser({ username: 'test', email: 'test@example.com', groups: [] })
      setUser(null)

      const state = useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.isAuthenticated).toBe(false)
    })
  })

  describe('setTokens', () => {
    it('stores all token types', () => {
      const { setTokens } = useAuthStore.getState()

      setTokens({
        accessToken: 'access-token-123',
        idToken: 'id-token-456',
        refreshToken: 'refresh-token-789',
      })

      const state = useAuthStore.getState()
      expect(state.accessToken).toBe('access-token-123')
      expect(state.idToken).toBe('id-token-456')
      expect(state.refreshToken).toBe('refresh-token-789')
      expect(state.isAuthenticated).toBe(true)
    })

    /*
     * Tokens only arrive from Cognito, so this is the one moment a session
     * goes from "restored from localStorage" to "validated" — and the only
     * thing that releases ProtectedRoute's validation gate. Drop it and a
     * *successful* refresh leaves the app on its loader forever, which is a
     * worse failure than the expired-session bug this replaced.
     */
    it('marks the session validated, releasing the boot-validation gate', () => {
      const { setTokens } = useAuthStore.getState()
      expect(useAuthStore.getState().sessionReady).toBe(false)

      setTokens({
        accessToken: 'access',
        idToken: 'id',
        refreshToken: 'refresh',
      })

      expect(useAuthStore.getState().sessionReady).toBe(true)
    })
  })

  describe('logout', () => {
    it('clears all authentication state', () => {
      const { setUser, setTokens, logout } = useAuthStore.getState()

      setUser({ username: 'test', email: 'test@example.com', groups: ['admins'] })
      setTokens({
        accessToken: 'access',
        idToken: 'id',
        refreshToken: 'refresh',
      })
      logout()

      const state = useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.accessToken).toBeNull()
      expect(state.idToken).toBeNull()
      expect(state.refreshToken).toBeNull()
    })

    it('resets authenticated and error state on logout', () => {
      const { setUser, setTokens, logout } = useAuthStore.getState()

      setUser({ username: 'test', email: 'test@example.com', groups: ['admins'] })
      setTokens({
        accessToken: 'access',
        idToken: 'id',
        refreshToken: 'refresh',
      })
      logout()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.error).toBeNull()
    })

    it('un-validates the session so the next page load revalidates', () => {
      const { setTokens, logout } = useAuthStore.getState()

      setTokens({ accessToken: 'access', idToken: 'id', refreshToken: 'refresh' })
      logout()

      expect(useAuthStore.getState().sessionReady).toBe(false)
    })
  })

  /*
   * The boot-validation gate in ProtectedRoute depends on `sessionReady` being
   * ABSENT from the persisted payload: it must come back false on every page
   * load, while `isAuthenticated` comes back true. Persist it and the gate is
   * inert — `needsValidation` would always be false, the app would render on a
   * restored-but-unvalidated session again, and every other test here would
   * still pass, because they run against a fresh in-memory store.
   *
   * Asserting the whole key set rather than just the one omission, so adding
   * any future field to the store forces a decision about persisting it.
   */
  describe('persisted shape', () => {
    it('persists identity but not the validated flag', () => {
      const { setUser, setTokens } = useAuthStore.getState()
      setUser({ username: 'test', email: 'test@example.com', groups: [] })
      setTokens({ accessToken: 'access', idToken: 'id', refreshToken: 'refresh' })

      /*
       * The suite's localStorage is a spy that stores nothing (see
       * test/setup.ts), so read what persist WROTE rather than trying to read
       * it back — which also inspects the payload more directly.
       */
      const writes = vi.mocked(localStorage.setItem).mock.calls
        .filter(([key]) => key === 'voc-auth')
      expect(writes.length).toBeGreaterThan(0)
      const raw = writes[writes.length - 1][1]
      const persisted: unknown = JSON.parse(raw)
      const shape = PersistedAuthSchema.parse(persisted)

      expect(Object.keys(shape.state).toSorted()).toEqual([
        'accessToken', 'idToken', 'isAuthenticated', 'user',
      ])
      // The refresh token is memory-only by design; see the store's docblock.
      expect(shape.state).not.toHaveProperty('refreshToken')
      expect(shape.state).not.toHaveProperty('sessionReady')
    })
  })

  describe('setLoading', () => {
    it('sets loading state to true', () => {
      const { setLoading } = useAuthStore.getState()

      setLoading(true)

      expect(useAuthStore.getState().isLoading).toBe(true)
    })

    it('sets loading state to false', () => {
      const { setLoading } = useAuthStore.getState()

      setLoading(true)
      setLoading(false)

      expect(useAuthStore.getState().isLoading).toBe(false)
    })
  })

  describe('setError', () => {
    it('sets error message', () => {
      const { setError } = useAuthStore.getState()

      setError('Invalid credentials')

      expect(useAuthStore.getState().error).toBe('Invalid credentials')
    })

    it('clears error when set to null', () => {
      const { setError } = useAuthStore.getState()

      setError('Some error')
      setError(null)

      expect(useAuthStore.getState().error).toBeNull()
    })
  })
})


/**
 * Regression tests for issue #177: useIsAdmin lacked the routes' documented
 * no-Cognito dev bypass, so mock-only local dev opened /settings (the routes
 * bypass) while hiding every isAdmin-driven surface. Vitest runs as a DEV
 * build (import.meta.env.DEV === true), which is exactly the branch under
 * test; the production side of the gate is compile-time eliminated by Vite
 * and enforced server-side (require_admin + Cognito authorizer) regardless.
 */
describe('useIsAdmin', () => {
  beforeEach(() => {
    useAuthStore.getState().logout()
    vi.clearAllMocks()
  })

  describe('dev bypass (Cognito not configured, issue #177)', () => {
    it('reports admin with no user at all', () => {
      stubCognito(false)

      const { result } = renderHook(() => useIsAdmin())

      expect(result.current).toBe(true)
    })

    it('treats an unloaded config as not configured (still bypasses)', () => {
      mockIsConfigLoaded.mockReturnValue(false)

      const { result } = renderHook(() => useIsAdmin())

      expect(result.current).toBe(true)
      // Pre-load short-circuit: the config must never be read while unloaded
      // (getRuntimeConfig throws in that state).
      expect(mockGetRuntimeConfig).not.toHaveBeenCalled()
    })
  })

  describe('with Cognito configured (the bypass must be inert)', () => {
    it('reports admin only for users in the admins group', () => {
      stubCognito(true)
      useAuthStore.getState().setUser({ username: 'ada', email: 'ada@example.com', groups: ['admins'] })

      const { result } = renderHook(() => useIsAdmin())

      expect(result.current).toBe(true)
    })

    it('denies users outside the admins group', () => {
      stubCognito(true)
      useAuthStore.getState().setUser({ username: 'vic', email: 'vic@example.com', groups: ['users'] })

      const { result } = renderHook(() => useIsAdmin())

      expect(result.current).toBe(false)
    })

    it('denies when no user is present', () => {
      stubCognito(true)

      const { result } = renderHook(() => useIsAdmin())

      expect(result.current).toBe(false)
    })
  })
})
