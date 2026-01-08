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

interface AdminRouteProps {
  /** Child components to render if user is admin */
  readonly children: React.ReactNode
  /** Optional redirect path for non-admins (defaults to '/') */
  readonly redirectTo?: string
}

/**
 * Wraps routes that require admin privileges.
 * Redirects non-admin users to the specified path (default: dashboard).
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
export default function AdminRoute({ children, redirectTo = '/' }: AdminRouteProps) {
  const location = useLocation()
  const { isAuthenticated } = useAuthStore()
  const isAdmin = useIsAdmin()

  // If Cognito is not configured, allow access in development mode
  if (!authService.isConfigured()) {
    if (import.meta.env.DEV) {
      return <>{children}</>
    }
    // In production, fail closed - require auth configuration
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // If not authenticated, redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // If authenticated but not admin, redirect to dashboard
  if (!isAdmin) {
    return <Navigate to={redirectTo} state={{ accessDenied: true }} replace />
  }

  return <>{children}</>
}
