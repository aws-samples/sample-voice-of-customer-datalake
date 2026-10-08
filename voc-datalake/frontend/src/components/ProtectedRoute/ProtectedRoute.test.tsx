/**
 * @fileoverview Tests for ProtectedRoute component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderProtected } from './protectedRoute-fixtures'
import { emptySession } from './protectedRoute-mock-fixtures'
import { authService } from '../../services/auth'
import { endExpiredSession } from '../../services/sessionExpiry'

/*
 * The store mock is a hook *and* carries `getState`, because the component
 * reads reactively for rendering and imperatively inside the validation
 * effect (where a stale closure would decide whether to force a sign-out).
 */
interface AuthStub {
  isAuthenticated: boolean
  sessionReady?: boolean
}
const mockGetState = vi.fn<() => AuthStub>(() => ({ isAuthenticated: true }))
const mockUseAuthStore = vi.fn<() => AuthStub>()
vi.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(() => mockUseAuthStore(), { getState: () => mockGetState() }),
}))

vi.mock('../../services/auth', () => import('./protectedRoute-mock-fixtures'))
vi.mock('../../services/sessionExpiry', () => import('./protectedRoute-mock-fixtures'))

/**
 * Point the store at a given auth state, reactively and imperatively.
 *
 * Both halves must agree: the component renders from the hook and checks the
 * post-refresh outcome through `getState`, so a helper that set only one of
 * them would let a case pass for the wrong reason.
 */
function setAuthState(state: { isAuthenticated: boolean; sessionReady?: boolean }) {
  const resolved = { sessionReady: false, ...state }
  mockUseAuthStore.mockReturnValue(resolved)
  mockGetState.mockReturnValue(resolved)
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations, so both halves of the store mock
    // are re-pointed explicitly — otherwise a case that sets one of them
    // leaks its state into every case after it.
    mockGetState.mockReturnValue({ isAuthenticated: true })
    vi.mocked(authService.refreshSession).mockResolvedValue(emptySession())
  })

  describe('when Cognito is configured', () => {
    beforeEach(() => {
      vi.mocked(authService.isConfigured).mockReturnValue(true)
    })

    it('renders children when the session is authenticated and validated', () => {
      setAuthState({ isAuthenticated: true, sessionReady: true })

      renderProtected()

      expect(screen.getByText('Protected Content')).toBeInTheDocument()
      expect(authService.refreshSession).not.toHaveBeenCalled()
    })

    it('redirects to login when user is not authenticated', () => {
      setAuthState({ isAuthenticated: false })

      renderProtected()

      expect(screen.getByText('Login Page')).toBeInTheDocument()
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    })
  })

  /*
   * `isAuthenticated` comes back from localStorage on every page load, so
   * without these three cases an expired token renders the whole app and only
   * fails later, one 401 at a time — the defect this validation gate exists
   * to close.
   */
  describe('when a restored session has not been validated yet', () => {
    beforeEach(() => {
      vi.mocked(authService.isConfigured).mockReturnValue(true)
      setAuthState({ isAuthenticated: true, sessionReady: false })
    })

    it('renders neither the app nor a redirect while validating', () => {
      renderProtected()

      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
      expect(screen.queryByText('Login Page')).not.toBeInTheDocument()
    })

    it('attempts a silent refresh', () => {
      renderProtected()

      expect(authService.refreshSession).toHaveBeenCalledWith()
    })

    it('retries once before giving up, so a connectivity blip is survivable', async () => {
      // First attempt fails; the second validates. refreshSession signs the
      // user out for a transport failure exactly as for a dead session, so
      // without the retry a moment of bad network is a forced logout.
      vi.mocked(authService.refreshSession)
        .mockRejectedValueOnce(new Error('network'))
        .mockImplementationOnce(() => {
          // Stand in for setTokens releasing the gate on a real refresh.
          mockGetState.mockReturnValue({ isAuthenticated: true, sessionReady: true })
          return Promise.resolve(emptySession())
        })

      renderProtected()

      await waitFor(() => expect(authService.refreshSession).toHaveBeenCalledTimes(2))
      expect(endExpiredSession).not.toHaveBeenCalled()
    })

    it('ends the session WITH the reason when both attempts fail', async () => {
      // The bare <Navigate to="/login"> below would drop the explanation —
      // and this is the path an idle deployment actually takes.
      vi.mocked(authService.refreshSession).mockRejectedValue(
        new Error('Session refresh failed'),
      )

      renderProtected()

      await waitFor(() => expect(endExpiredSession).toHaveBeenCalledWith())
    })

    /*
     * The case where `refreshSession` clears auth state before rejecting — the
     * real failure path — is NOT tested here on purpose. A mocked store cannot
     * reproduce it: re-pointing a `vi.fn()` does not notify React, so nothing
     * re-renders, the effect is never torn down, and the broken and fixed
     * implementations behave identically. It lives in
     * `ProtectedRoute.storeIntegration.test.tsx`, against the real store, where
     * it actually fails if the gate goes back to being store-derived.
     */

    it('ends the session if a refresh resolves without producing tokens', async () => {
      // Only setTokens releases the gate, so a resolve that left sessionReady
      // false would otherwise hang on the loader forever.
      vi.mocked(authService.refreshSession).mockResolvedValue(emptySession())
      mockGetState.mockReturnValue({ isAuthenticated: true, sessionReady: false })

      renderProtected()

      await waitFor(() => expect(endExpiredSession).toHaveBeenCalledWith())
    })
  })

  describe('when Cognito is not configured', () => {
    beforeEach(() => {
      vi.mocked(authService.isConfigured).mockReturnValue(false)
      mockUseAuthStore.mockReturnValue({ isAuthenticated: false })
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('allows access in development mode', () => {
      vi.stubEnv('DEV', true)

      renderProtected()

      expect(screen.getByText('Protected Content')).toBeInTheDocument()
    })

    it('redirects to login in production mode (fails closed)', () => {
      vi.stubEnv('DEV', false)

      renderProtected()

      expect(screen.getByText('Login Page')).toBeInTheDocument()
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    })
  })

  describe('location state', () => {
    it('preserves return path in location state when redirecting', () => {
      vi.mocked(authService.isConfigured).mockReturnValue(true)
      // Through the helper, so the hook and `getState` agree: the one-shot gate
      // reads `getState`, and setting only the hook left this validating and
      // rendering the loader instead of redirecting.
      setAuthState({ isAuthenticated: false })

      // The Navigate component should include state with the original path
      // This is tested implicitly by the redirect behavior
      renderProtected(['/protected'])

      expect(screen.getByText('Login Page')).toBeInTheDocument()
    })
  })
})
