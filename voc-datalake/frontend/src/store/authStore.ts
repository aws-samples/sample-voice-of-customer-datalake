/**
 * @fileoverview Authentication state management using Zustand with localStorage persistence.
 * 
 * Security model (mirrors Chrome extension pattern):
 * - Short-lived tokens (access, ID) persisted in localStorage for cross-tab UX
 * - Refresh token kept in memory only (never persisted) to limit XSS blast radius
 * - Non-secret data (user info, auth state) persisted in localStorage
 * 
 * When a new tab opens with expired short-lived tokens, the auth service
 * falls back to Cognito's getSession() which uses Cognito's own cookies
 * for silent re-authentication — no re-login needed.
 * 
 * @module store/authStore
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Authenticated user information extracted from Cognito ID token.
 */
export interface User {
  /** Cognito username */
  username: string
  /** User's email address */
  email: string
  /** User's display name (fullname attribute) */
  name?: string
  /** Cognito user groups for authorization */
  groups: string[]
}

/**
 * Authentication state interface for the Zustand store.
 */
interface AuthState {
  /** Current authenticated user or null if not authenticated */
  user: User | null
  /** JWT access token for API authorization */
  accessToken: string | null
  /** JWT ID token containing user claims */
  idToken: string | null
  /** Refresh token for obtaining new access tokens */
  refreshToken: string | null
  /** Whether the user is currently authenticated */
  isAuthenticated: boolean
  /** Whether the session has been validated/refreshed after page load */
  sessionReady: boolean
  /** Loading state for async auth operations */
  isLoading: boolean
  /** Error message from failed auth operations */
  error: string | null
  /** Update the current user */
  setUser: (user: User | null) => void
  /** Store all authentication tokens */
  setTokens: (tokens: { accessToken: string; idToken: string; refreshToken: string }) => void
  /** Mark session as validated and ready for API calls */
  setSessionReady: (ready: boolean) => void
  /** Set loading state */
  setLoading: (loading: boolean) => void
  /** Set error message */
  setError: (error: string | null) => void
  /** Clear all auth state and tokens */
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      idToken: null,
      refreshToken: null,
      isAuthenticated: false,
      sessionReady: false,
      isLoading: false,
      error: null,
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      setTokens: (tokens) => set({
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        isAuthenticated: true,
      }),
      setSessionReady: (sessionReady) => set({ sessionReady }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),
      logout: () => set({
        user: null,
        accessToken: null,
        idToken: null,
        refreshToken: null,
        isAuthenticated: false,
        sessionReady: false,
        error: null,
      }),
    }),
    { 
      name: 'voc-auth',
      // Persist short-lived tokens + user info in localStorage for cross-tab UX.
      // refreshToken is deliberately excluded — it stays in memory only.
      // This limits XSS blast radius: stolen access/ID tokens expire in ~1hr,
      // while the 30-day refresh token is never written to disk.
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        idToken: state.idToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)

/**
 * Helper hook to check if current user is an admin.
 * @returns true if user is in the 'admins' group
 */
export const useIsAdmin = (): boolean => {
  const user = useAuthStore((state) => state.user)
  return user?.groups?.includes('admins') ?? false
}
