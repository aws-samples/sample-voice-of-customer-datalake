/**
 * @fileoverview Tests for AdminRoute component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import AdminRoute from './AdminRoute'
import { useAuthStore } from '../../store/authStore'
import { authService } from '../../services/auth'

// Mock auth store
vi.mock('../../store/authStore', () => ({
  useAuthStore: vi.fn(),
  useIsAdmin: vi.fn(),
}))

// Mock auth service
vi.mock('../../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(),
  },
}))

const mockUseAuthStore = vi.mocked(useAuthStore)
const mockAuthService = vi.mocked(authService)

// Import useIsAdmin after mocking
import { useIsAdmin } from '../../store/authStore'
const mockUseIsAdmin = vi.mocked(useIsAdmin)

function renderWithRouter(
  element: React.ReactElement,
  { initialEntries = ['/admin'] } = {}
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/" element={<div>Dashboard</div>} />
        <Route path="/admin" element={element} />
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
      mockUseAuthStore.mockReturnValue({
        isAuthenticated: true,
        user: { username: 'admin', email: 'admin@test.com', groups: ['admins'] },
      } as ReturnType<typeof useAuthStore>)
      mockUseIsAdmin.mockReturnValue(true)

      renderWithRouter(
        <AdminRoute>
          <div>Admin Content</div>
        </AdminRoute>
      )

      expect(screen.getByText('Admin Content')).toBeInTheDocument()
    })

    it('redirects to login when user is not authenticated', () => {
      mockUseAuthStore.mockReturnValue({
        isAuthenticated: false,
        user: null,
      } as ReturnType<typeof useAuthStore>)
      mockUseIsAdmin.mockReturnValue(false)

      renderWithRouter(
        <AdminRoute>
          <div>Admin Content</div>
        </AdminRoute>
      )

      expect(screen.getByText('Login Page')).toBeInTheDocument()
      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument()
    })

    it('redirects to dashboard when user is authenticated but not admin', () => {
      mockUseAuthStore.mockReturnValue({
        isAuthenticated: true,
        user: { username: 'user', email: 'user@test.com', groups: ['viewers'] },
      } as ReturnType<typeof useAuthStore>)
      mockUseIsAdmin.mockReturnValue(false)

      renderWithRouter(
        <AdminRoute>
          <div>Admin Content</div>
        </AdminRoute>
      )

      expect(screen.getByText('Dashboard')).toBeInTheDocument()
      expect(screen.queryByText('Admin Content')).not.toBeInTheDocument()
    })

    it('redirects to custom path when specified', () => {
      mockUseAuthStore.mockReturnValue({
        isAuthenticated: true,
        user: { username: 'user', email: 'user@test.com', groups: ['viewers'] },
      } as ReturnType<typeof useAuthStore>)
      mockUseIsAdmin.mockReturnValue(false)

      render(
        <MemoryRouter initialEntries={['/admin']}>
          <Routes>
            <Route path="/custom" element={<div>Custom Page</div>} />
            <Route
              path="/admin"
              element={
                <AdminRoute redirectTo="/custom">
                  <div>Admin Content</div>
                </AdminRoute>
              }
            />
          </Routes>
        </MemoryRouter>
      )

      expect(screen.getByText('Custom Page')).toBeInTheDocument()
    })
  })

  describe('when Cognito is not configured', () => {
    beforeEach(() => {
      mockAuthService.isConfigured.mockReturnValue(false)
    })

    it('allows access in development mode', () => {
      const originalEnv = import.meta.env.DEV
      // @ts-expect-error - modifying read-only property for test
      import.meta.env.DEV = true

      mockUseAuthStore.mockReturnValue({
        isAuthenticated: false,
        user: null,
      } as ReturnType<typeof useAuthStore>)
      mockUseIsAdmin.mockReturnValue(false)

      renderWithRouter(
        <AdminRoute>
          <div>Admin Content</div>
        </AdminRoute>
      )

      expect(screen.getByText('Admin Content')).toBeInTheDocument()

      // @ts-expect-error - restoring read-only property
      import.meta.env.DEV = originalEnv
    })
  })
})
