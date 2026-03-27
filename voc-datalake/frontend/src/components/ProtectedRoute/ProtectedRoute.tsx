/**
 * @fileoverview Route protection component for authenticated-only access.
 *
 * Security behavior:
 * - Production: Requires Cognito authentication; redirects to /login if not authenticated
 * - Development: Allows unauthenticated access when Cognito is not configured (for local dev)
 * - Fails closed in production - if Cognito isn't configured, access is denied
 * - Validates/refreshes the session before rendering children to prevent 401 bursts
 *
 * @module components/ProtectedRoute
 */

import { useEffect } from 'react'
import {
  Navigate, useLocation,
} from 'react-router-dom'
import { authService } from '../../services/auth'
import { useAuthStore } from '../../store/authStore'
import PageLoader from '../PageLoader'

interface ProtectedRouteProps {
  /** Child components to render if authenticated */
  children: React.ReactNode
}

/**
 * Wraps routes that require authentication.
 * Validates the session on mount (refreshing tokens if needed) before
 * allowing child components to render and fire API queries.
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
  const {
    isAuthenticated, sessionReady, setSessionReady,
  } = useAuthStore()

  useEffect(() => {
    if (!isAuthenticated || sessionReady) return

    const abortController = new AbortController()

    async function validateSession() {
      try {
        // Proactively refresh tokens so downstream queries get a valid token
        await authService.refreshSession()
      } catch {
        // refreshSession already calls logout on failure,
        // so the isAuthenticated check below will redirect to /login
      } finally {
        if (!abortController.signal.aborted) {
          setSessionReady(true)
        }
      }
    }

    void validateSession()
    return () => {
      abortController.abort()
    }
  }, [isAuthenticated, sessionReady, setSessionReady])

  // If Cognito is not configured, only allow access in development mode
  if (!authService.isConfigured()) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line react/jsx-no-useless-fragment -- needed for consistent return type
      return <>{children}</>
    }
    // In production, fail closed - require auth configuration
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // If not authenticated, redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // Wait for session validation before rendering children
  if (!sessionReady) {
    return <PageLoader />
  }

  // eslint-disable-next-line react/jsx-no-useless-fragment -- needed for consistent return type
  return <>{children}</>
}
