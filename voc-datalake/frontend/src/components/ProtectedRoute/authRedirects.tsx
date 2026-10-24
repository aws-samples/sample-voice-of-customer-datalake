/**
 * @fileoverview The redirects the route guards (ProtectedRoute, AdminRoute)
 * share, so the two cannot drift on where an unauthenticated or unconfigured
 * visitor is sent.
 *
 * @module components/ProtectedRoute/authRedirects
 */

import { Navigate } from 'react-router-dom'

interface LoginRedirectProps {
  /** The path the visitor was trying to reach; Login sends them back there. */
  readonly from: string
}

/** Send the visitor to /login, remembering where they came from. */
export function LoginRedirect({ from }: LoginRedirectProps) {
  return <Navigate to="/login" state={{ from }} replace />
}

interface UnconfiguredAuthFallbackProps extends LoginRedirectProps {
  readonly children: React.ReactNode
}

/**
 * What a guard renders when Cognito is not configured: the page itself in
 * development (so the mock-only setup stays usable), a login redirect in
 * production (fail closed — require auth configuration).
 */
export function UnconfiguredAuthFallback({ children, from }: UnconfiguredAuthFallbackProps) {
  if (import.meta.env.DEV) {
    return <>{children}</>
  }
  return <LoginRedirect from={from} />
}
