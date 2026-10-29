/**
 * @fileoverview Route protection component for admin-only access.
 * 
 * Security behavior:
 * - Requires user to be authenticated AND in the 'admins' group
 * - Redirects non-admin users to the dashboard with an access denied message
 * - In development without Cognito, allows access for easier testing
 * 
 * @module components/AdminRoute
 */

import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore, useIsAdmin } from '../../store/authStore'
import { authService } from '../../services/auth'
import { LoginRedirect, UnconfiguredAuthFallback } from '../ProtectedRoute/authRedirects'

interface AdminRouteProps {
  /** Child components to render if user is admin */
  readonly children: React.ReactNode
}

/**
 * Wraps routes that require admin privileges.
 * Redirects non-admin users to the dashboard.
 * 
 * @example
 * ```tsx
 * <Route path="/settings" element={
 *   <AdminRoute>
 *     <Settings />
 *   </AdminRoute>
 * } />
 * ```
 */
export default function AdminRoute({ children }: AdminRouteProps) {
  const location = useLocation()
  const { isAuthenticated } = useAuthStore()
  const isAdmin = useIsAdmin()

  // If Cognito is not configured, allow access in development mode
  if (!authService.isConfigured()) {
    return <UnconfiguredAuthFallback from={location.pathname}>{children}</UnconfiguredAuthFallback>
  }

  // If not authenticated, redirect to login
  if (!isAuthenticated) {
    return <LoginRedirect from={location.pathname} />
  }

  // If authenticated but not admin, redirect to dashboard
  if (!isAdmin) {
    return <Navigate to="/" state={{ accessDenied: true }} replace />
  }

  return <>{children}</>
}
