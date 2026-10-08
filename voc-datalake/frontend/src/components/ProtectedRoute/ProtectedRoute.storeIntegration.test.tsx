/**
 * @fileoverview ProtectedRoute against the REAL auth store.
 *
 * Why a second file: `ProtectedRoute.test.tsx` mocks the store, and a mocked
 * store cannot reproduce the defect this file exists to pin. Changing a
 * `vi.fn()`'s return value does not notify React, so no re-render happens, the
 * effect is never torn down, and the broken and fixed implementations behave
 * identically — a test written there passes either way.
 *
 * The defect: `refreshSession` clears auth state internally before it rejects.
 * With the validation gate DERIVED from the store, that clearing flipped the
 * gate, React re-ran the effect deps, the cleanup fired mid-flight, and both
 * the retry and the `?expired=1` redirect were cancelled — dropping the user on
 * the bare login form this component exists to avoid. Only a real store, which
 * really notifies subscribers, exercises that sequence.
 *
 * @module components/ProtectedRoute
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderProtected } from './protectedRoute-fixtures'
import { emptySession } from './protectedRoute-mock-fixtures'
import { useAuthStore } from '../../store/authStore'
import { authService } from '../../services/auth'
import { endExpiredSession } from '../../services/sessionExpiry'

vi.mock('../../services/auth', () => import('./protectedRoute-mock-fixtures'))
vi.mock('../../services/sessionExpiry', () => import('./protectedRoute-mock-fixtures'))

/**
 * The state a page load produces: `isAuthenticated` came back from
 * localStorage, `sessionReady` did not (it is excluded from `partialize`).
 */
function restoreUnvalidatedSession() {
  useAuthStore.setState({
    user: { username: 'u', email: 'u@example.com', groups: [] },
    accessToken: 'restored-access',
    idToken: 'restored-id',
    refreshToken: null,
    isAuthenticated: true,
    sessionReady: false,
  })
}

describe('ProtectedRoute against the real auth store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authService.isConfigured).mockReturnValue(true)
    useAuthStore.getState().logout()
  })

  it('ends the session with the reason even though the refresh clears auth state first', async () => {
    restoreUnvalidatedSession()
    // Exactly what the real refreshSession does on a rejected refresh.
    vi.mocked(authService.refreshSession).mockImplementation(() => {
      useAuthStore.getState().logout()
      return Promise.reject(new Error('Session refresh failed'))
    })

    renderProtected()

    await waitFor(() => expect(endExpiredSession).toHaveBeenCalledWith(), { timeout: 3000 })
    // No flash of the unexplained form while that redirect resolves.
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument()
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })

  it('renders the app once a real refresh validates the restored session', async () => {
    restoreUnvalidatedSession()
    vi.mocked(authService.refreshSession).mockImplementation(() => {
      useAuthStore.getState().setTokens({
        accessToken: 'fresh-access',
        idToken: 'fresh-id',
        refreshToken: 'fresh-refresh',
      })
      return Promise.resolve(emptySession())
    })

    renderProtected()

    expect(await screen.findByText('Protected Content')).toBeInTheDocument()
    expect(endExpiredSession).not.toHaveBeenCalled()
  })

  it('does not revalidate a session that is already validated', () => {
    restoreUnvalidatedSession()
    useAuthStore.getState().setTokens({
      accessToken: 'a', idToken: 'b', refreshToken: 'c',
    })

    renderProtected()

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
    expect(authService.refreshSession).not.toHaveBeenCalled()
  })
})
