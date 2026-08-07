/**
 * @fileoverview Route protection component for authenticated-only access.
 * 
 * Security behavior:
 * - Production: Requires Cognito authentication; redirects to /login if not authenticated
 * - Development: Allows unauthenticated access when Cognito is not configured (for local dev)
 * - Fails closed in production - if Cognito isn't configured, access is denied
 * - Revalidates a restored session before rendering anything behind it
 * 
 * @module components/ProtectedRoute
 */

import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { authService } from '../../services/auth'
import PageLoader from '../PageLoader'

interface ProtectedRouteProps {
  /** Child components to render if authenticated */
  children: React.ReactNode
}

/**
 * Wraps routes that require authentication.
 * Redirects unauthenticated users to /login with return path preserved.
 * 
 * @example
 * ```tsx
 * <Route path="/dashboard" element={
 *   <ProtectedRoute>
 *     <Dashboard />
 *   </ProtectedRoute>
 * } />
 * ```
 */
export default function ProtectedRoute({ children }: Readonly<ProtectedRouteProps>) {
  const location = useLocation()
  const { isAuthenticated, sessionReady } = useAuthStore()

  /*
   * `isAuthenticated` is restored from localStorage, so on a fresh page load
   * it says "signed in" whether or not the token behind it is still alive.
   * Rendering on that alone is what made an expired session look like a
   * working application: the full shell appeared, then every request 401'd.
   *
   * `sessionReady` is the difference between restored and *validated*. It is
   * set only when tokens arrive from Cognito (see authStore.setTokens) and
   * cleared on logout, so it is false exactly once per page load — one
   * refresh, not one per navigation.
   */
  const needsValidation = isAuthenticated && !sessionReady && authService.isConfigured()

  useEffect(() => {
    if (!needsValidation) return

    /*
     * Guards a late rejection: if the user has already left for /login and
     * started signing in, a refresh failure landing afterwards must not sign
     * out the session they just created. (Object rather than `let` — the
     * codebase's local-mutable idiom.)
     */
    const run = { live: true }

    void authService.refreshSession().catch(() => {
      /*
       * refreshSession clears auth state itself for the failures it can
       * attribute (no current user, refresh rejected). A ConfigError leaves
       * it intact, which would strand this component on its loader forever —
       * so fail closed here rather than trusting that.
       */
      if (run.live && useAuthStore.getState().isAuthenticated) {
        authService.signOut()
      }
    })

    return () => { run.live = false }
  }, [needsValidation])

  // If Cognito is not configured, only allow access in development mode
  if (!authService.isConfigured()) {
    if (import.meta.env.DEV) {
      return <>{children}</>
    }
    // In production, fail closed - require auth configuration
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // Hold the shell back until the restored session is confirmed. On failure
  // the effect above clears auth state, which falls through to the redirect.
  if (needsValidation) {
    return <PageLoader />
  }

  // If not authenticated, redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  return <>{children}</>
}
