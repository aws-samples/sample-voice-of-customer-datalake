/**
 * @fileoverview Authentication state management using Zustand with sessionStorage persistence.
 * 
 * Security considerations:
 * - Uses sessionStorage instead of localStorage to limit token exposure
 * - Tokens are automatically cleared when browser tab/window closes
 * - Reduces risk of XSS-based token theft compared to localStorage
 * 
 * @module store/authStore
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Authenticated user information extracted from Cognito ID token.
 */
export interface User {
  /** Cognito username */
  username: string
  /** User's email address */
  email: string
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
  /** Loading state for async auth operations */
  isLoading: boolean
  /** Error message from failed auth operations */
  error: string | null
  /** Update the current user */
  setUser: (user: User | null) => void
  /** Store all authentication tokens */
  setTokens: (tokens: { accessToken: string; idToken: string; refreshToken: string }) => void
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
      isLoading: false,
      error: null,
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      setTokens: (tokens) => set({
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        isAuthenticated: true,
      }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),
      logout: () => set({
        user: null,
        accessToken: null,
        idToken: null,
        refreshToken: null,
        isAuthenticated: false,
        error: null,
      }),
    }),
    { 
      name: 'voc-auth',
      // Use sessionStorage instead of localStorage for security
      // Tokens are cleared when browser tab/window is closed
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        idToken: state.idToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
