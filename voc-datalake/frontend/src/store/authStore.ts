/**
 * @fileoverview Authentication state management using Zustand with localStorage persistence.
 *
 * Security model:
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
import { getRuntimeConfig, isConfigLoaded } from '../runtimeConfig'

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
  setTokens: (tokens: {
    accessToken: string;
    idToken: string;
    refreshToken: string
  }) => void
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
      setUser: (user) => set({
        user,
        isAuthenticated: !!user,
      }),
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
    },
  ),
)

/**
 * Whether Cognito is configured in the runtime config. Mirrors
 * authService.isConfigured(), which cannot be imported here because
 * services/auth.ts imports this store (import cycle).
 *
 * Pre-load: "config not loaded yet" is treated as "not configured", which
 * in a DEV build activates the bypass below. This is safe ONLY because
 * App.tsx gates <RouterProvider> on loadRuntimeConfig() resolving
 * (configReady state), so no component calls this hook pre-load. If that
 * loading gate is ever refactored away, a DEV build pointed at real
 * Cognito would briefly report admin during the load window — keep the
 * gate, or make this reactive to config load. The unloaded short-circuit
 * itself is pinned by a test (getRuntimeConfig must not be called).
 */
function cognitoConfigured(): boolean {
  if (!isConfigLoaded()) return false
  const cfg = getRuntimeConfig()
  return cfg.cognito.userPoolId !== '' && cfg.cognito.clientId !== ''
}

/**
 * Helper hook to check if current user is an admin.
 *
 * Local-dev bypass (issue #177): when Cognito is NOT configured and this is
 * a DEV build, report admin — mirroring the documented bypass in
 * ProtectedRoute/AdminRoute. Without it the routes open but every
 * isAdmin-driven surface (Settings sidebar link, Users tab, AI Models card)
 * stays hidden in mock-only dev. A production build without Cognito still
 * fails closed here, exactly like the routes.
 *
 * @returns true if user is in the 'admins' group (or in the dev bypass)
 */
export const useIsAdmin = (): boolean => {
  const user = useAuthStore((state) => state.user)
  if (import.meta.env.DEV && !cognitoConfigured()) {
    return true
  }
  return user?.groups.includes('admins') ?? false
}
