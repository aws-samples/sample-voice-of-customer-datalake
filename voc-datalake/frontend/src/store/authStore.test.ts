/**
 * @fileoverview Tests for authStore Zustand store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAuthStore } from './authStore'

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
