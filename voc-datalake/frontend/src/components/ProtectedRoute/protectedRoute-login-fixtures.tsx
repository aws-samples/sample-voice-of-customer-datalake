/**
 * @fileoverview Spec support for ProtectedRoute: the `/login` stand-in, which shows where Login
 * would send the visitor back (`state.from`, path and query).
 */
import { useLocation } from 'react-router-dom'
import { z } from 'zod'

const LoginStateSchema = z.object({ from: z.string() })

export function LoginProbe() {
  const routeState: unknown = useLocation().state
  const parsed = LoginStateSchema.safeParse(routeState)
  return <div>Login Page<span data-testid="login-from">{parsed.success ? parsed.data.from : ''}</span></div>
}
