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
import { endExpiredSession } from '../../services/sessionExpiry'
import PageLoader from '../PageLoader'

/**
 * Pause before the single boot-validation retry. Long enough for a brief
 * connectivity gap to clear, short enough to stay inside the loading state a
 * user already accepts.
 */
const BOOT_REFRESH_RETRY_MS = 300

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
     * Stops OUR follow-up work after unmount — it cannot cancel the refresh
     * itself, and `refreshSession` clears auth state internally for the
     * failures it can attribute, so that part happens either way. What this
     * prevents is a late failure redirecting a user who has already reached
     * /login and signed in again.
     *
     * Object rather than `let` because `no-restricted-syntax` bans `let`.
     */
    const run = { live: true }

    /**
     * @returns whether the session came back validated
     */
    const attemptRefresh = async (): Promise<boolean> => {
      try {
        await authService.refreshSession()
      } catch {
        return false
      }
      /*
       * A post-condition, not trust: only `setTokens` releases the gate, so a
       * resolve that somehow produced no tokens would leave this component on
       * its loader forever — the failure this gate exists to avoid.
       */
      return useAuthStore.getState().sessionReady
    }

    const validate = async () => {
      if (await attemptRefresh()) return

      /*
       * `refreshSession` rejects — and signs out — for a transport failure just
       * as it does for a genuinely dead session, and this now runs on every
       * page load. One retry keeps a moment of bad connectivity from becoming
       * a forced logout; a real expiry just costs one extra round-trip.
       */
      await new Promise((resolve) => setTimeout(resolve, BOOT_REFRESH_RETRY_MS))
      if (!run.live) return
      if (await attemptRefresh()) return

      /*
       * End it with the REASON, rather than falling through to the bare
       * `<Navigate to="/login">` below. This is the path an idle deployment
       * actually takes, so it is the one that most needs the explanation.
       */
      if (run.live) endExpiredSession()
    }

    void validate()

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
