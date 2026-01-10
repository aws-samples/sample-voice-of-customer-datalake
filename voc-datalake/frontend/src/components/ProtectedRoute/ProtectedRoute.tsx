/**
 * @fileoverview Route protection component for authenticated-only access.
 * 
 * Security behavior:
 * - Production: Requires Cognito authentication; redirects to /login if not authenticated
 * - Development: Allows unauthenticated access when Cognito is not configured (for local dev)
 * - Fails closed in production - if Cognito isn't configured, access is denied
 * 
 * @module components/ProtectedRoute
 */

import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'
import { authService } from '../../services/auth'

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
  const { isAuthenticated } = useAuthStore()

  // If Cognito is not configured, only allow access in development mode
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

  return <>{children}</>
}
