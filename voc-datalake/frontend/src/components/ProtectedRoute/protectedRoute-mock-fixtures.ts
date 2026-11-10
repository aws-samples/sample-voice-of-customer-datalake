/**
 * @fileoverview Stand-in module shared by both ProtectedRoute suites, so the
 * mocked-store and real-store suites stub the auth service and the expiry
 * redirect identically.
 *
 * It exports BOTH replacements, so each suite mocks either module with the same
 * one-liner: `vi.mock('../../services/auth', () => import('./protectedRoute-mock-fixtures'))`
 * (and likewise for `services/sessionExpiry`). Each suite gets its own module
 * registry, so the spies are per file, exactly as a per-call factory was.
 *
 * Kept apart from `protectedRoute-fixtures.tsx` on purpose: that file imports
 * the component (and so the mocked modules), which a mock factory must not.
 */
import { vi } from 'vitest'

/** `services/auth`: configured by default; refresh and sign-out are bare spies. */
export const authService = {
  isConfigured: vi.fn(() => true),
  refreshSession: vi.fn((): Promise<void> => Promise.resolve()),
  signOut: vi.fn(),
}

/** `services/sessionExpiry`: the redirect-with-reason is a spy. */
export const endExpiredSession = vi.fn()
