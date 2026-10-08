/**
 * @fileoverview Tests for AdminRoute component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import AdminRoute from './AdminRoute'
import { authService } from '../../services/auth'

/*
 * AdminRoute reads only `isAuthenticated` from the store and the admin flag
 * from `useIsAdmin`, so the stubs model exactly that slice — typed, with no
 * cast to the full store state.
 */
interface AuthStub {
  isAuthenticated: boolean
}
const { mockUseAuthStore, mockUseIsAdmin } = vi.hoisted(() => ({
  mockUseAuthStore: vi.fn<() => AuthStub>(),
  mockUseIsAdmin: vi.fn<() => boolean>(),
}))
vi.mock('../../store/authStore', () => ({
  useAuthStore: () => mockUseAuthStore(),
  useIsAdmin: () => mockUseIsAdmin(),
}))

vi.mock('../../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(),
  },
}))

const mockAuthService = vi.mocked(authService)

/** Point the mocked store at a signed-in user, with `isAdmin` as useIsAdmin's answer. */
function signedIn(isAdmin: boolean) {
  mockUseAuthStore.mockReturnValue({ isAuthenticated: true })
  mockUseIsAdmin.mockReturnValue(isAdmin)
}

/** Point the mocked store at an anonymous visitor. */
function signedOut() {
  mockUseAuthStore.mockReturnValue({ isAuthenticated: false })
  mockUseIsAdmin.mockReturnValue(false)
}

/**
 * Mount the guard at /admin around a marker child, beside every page it can
 * send a visitor to: the dashboard (default for non-admins), the login page,
 * and a custom `redirectTo` target.
 */
function renderAdminContent(guardProps: { redirectTo?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/" element={<div>Dashboard</div>} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/custom" element={<div>Custom Page</div>} />
        <Route
          path="/admin"
          element={
            <AdminRoute {...guardProps}>
              <div>Admin Content</div>
            </AdminRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('AdminRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthService.isConfigured.mockReturnValue(true)
  })

  describe('when Cognito is configured', () => {
    it('renders children when user is authenticated and admin', () => {
      signedIn(true)

      renderAdminContent()

      expect(screen.getByText('Admin Content')).toBeInTheDocument()
    })

    it('redirects to login when user is not authenticated', () => {
      signedOut()

      renderAdminContent()

      expect(screen.getByText('Login Page')).toBeInTheDocument()
      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument()
    })

    it('redirects to dashboard when user is authenticated but not admin', () => {
      signedIn(false)

      renderAdminContent()

      expect(screen.getByText('Dashboard')).toBeInTheDocument()
      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument()
    })

    it('redirects to custom path when specified', () => {
      signedIn(false)

      renderAdminContent({ redirectTo: '/custom' })

      expect(screen.getByText('Custom Page')).toBeInTheDocument()
    })
  })

  describe('when Cognito is not configured', () => {
    beforeEach(() => {
      mockAuthService.isConfigured.mockReturnValue(false)
      signedOut()
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('allows access in development mode', () => {
      vi.stubEnv('DEV', true)

      renderAdminContent()

      expect(screen.getByText('Admin Content')).toBeInTheDocument()
    })
  })
})
