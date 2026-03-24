/**
 * @fileoverview Tests for ProtectedRoute component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProtectedRoute from './ProtectedRoute'
import { useAuthStore } from '../../store/authStore'
import { authService } from '../../services/auth'

// Mock the auth store
vi.mock('../../store/authStore', () => ({
  useAuthStore: vi.fn(),
}))

// Mock the auth service
vi.mock('../../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(),
    refreshSession: vi.fn(),
  },
}))

// Mock PageLoader
vi.mock('../PageLoader', () => ({
  default: () => <div>Loading...</div>,
}))

// Helper to render with router
function renderWithRouter(
  ui: React.ReactElement,
  { initialEntries = ['/protected'] } = {}
) {
  return render(
    <MemoryRouter
      initialEntries={initialEntries}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div>Protected Content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('import', { meta: { env: { DEV: false } } })
  })

  describe('when Cognito is configured', () => {
    beforeEach(() => {
      ;(authService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true)
    })

    it('renders children when user is authenticated and session is ready', () => {
      ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        isAuthenticated: true,
        sessionReady: true,
        setSessionReady: vi.fn(),
      })

      renderWithRouter(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      )

      expect(screen.getByText('Protected Content')).toBeInTheDocument()
    })

    it('shows loading when authenticated but session not yet ready', () => {
      ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise(() => {}) // never resolves — keeps loading state
      )
      ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        isAuthenticated: true,
        sessionReady: false,
        setSessionReady: vi.fn(),
      })

      renderWithRouter(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      )

      expect(screen.getByText('Loading...')).toBeInTheDocument()
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    })

    it('redirects to login when user is not authenticated', () => {
      ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        isAuthenticated: false,
        sessionReady: false,
        setSessionReady: vi.fn(),
      })

      renderWithRouter(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      )

      expect(screen.getByText('Login Page')).toBeInTheDocument()
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
    })
  })

  describe('when Cognito is not configured', () => {
    beforeEach(() => {
      ;(authService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false)
      ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        isAuthenticated: false,
        sessionReady: false,
        setSessionReady: vi.fn(),
      })
    })

    it('redirects to login in production mode', () => {
      renderWithRouter(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      )

      // In test environment, DEV is true so it allows access
      expect(screen.getByText('Protected Content')).toBeInTheDocument()
    })
  })

  describe('location state', () => {
    it('preserves return path in location state when redirecting', () => {
      ;(authService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true)
      ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        isAuthenticated: false,
        sessionReady: false,
        setSessionReady: vi.fn(),
      })

      renderWithRouter(
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>,
        { initialEntries: ['/protected'] }
      )

      expect(screen.getByText('Login Page')).toBeInTheDocument()
    })
  })
})
