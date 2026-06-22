/**
 * @fileoverview Tests for Login page component.
 * @module pages/Login
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock auth service
const mockSignIn = vi.fn()
const mockCompleteNewPassword = vi.fn()
const mockForgotPassword = vi.fn()
const mockConfirmPassword = vi.fn()

vi.mock('../../services/auth', () => ({
  authService: {
    signIn: (username: string, password: string) => mockSignIn(username, password),
    completeNewPassword: (user: unknown, password: string) => mockCompleteNewPassword(user, password),
    forgotPassword: (username: string) => mockForgotPassword(username),
    confirmPassword: (username: string, code: string, password: string) => mockConfirmPassword(username, code, password),
  },
}))

// Mock react-router-dom
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ state: { from: '/dashboard' } }),
  }
})

import Login from './Login'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/login']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('initial render', () => {
    it('displays VoC Analytics branding', () => {
      render(<Login />, { wrapper: createWrapper() })
      
      expect(screen.getByText('VoC Analytics')).toBeInTheDocument()
      expect(screen.getByText('Voice of the Customer Analytics')).toBeInTheDocument()
    })

    it('displays login form with username and password fields', () => {
      render(<Login />, { wrapper: createWrapper() })
      
      expect(screen.getByPlaceholderText(/Enter your username/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/Enter your password/i)).toBeInTheDocument()
    })

    it('displays sign in button', () => {
      render(<Login />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
    })

    it('displays forgot password link', () => {
      render(<Login />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/forgot password/i)).toBeInTheDocument()
    })

    it('displays contact administrator message', () => {
      render(<Login />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Contact your administrator/i)).toBeInTheDocument()
    })
  })

  describe('login form submission', () => {
    it('calls signIn with username and password on submit', async () => {
      const user = userEvent.setup()
      mockSignIn.mockResolvedValue({})
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.type(screen.getByPlaceholderText(/Enter your password/i), 'password123')
      await user.click(screen.getByRole('button', { name: /sign in/i }))
      
      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('testuser', 'password123')
      })
    })

    it('navigates to original destination after successful login', async () => {
      const user = userEvent.setup()
      mockSignIn.mockResolvedValue({})
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.type(screen.getByPlaceholderText(/Enter your password/i), 'password123')
      await user.click(screen.getByRole('button', { name: /sign in/i }))
      
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true })
      })
    })

    it('displays error message on login failure', async () => {
      const user = userEvent.setup()
      mockSignIn.mockRejectedValue({ message: 'Invalid credentials' })
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.type(screen.getByPlaceholderText(/Enter your password/i), 'wrongpassword')
      await user.click(screen.getByRole('button', { name: /sign in/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Invalid credentials')).toBeInTheDocument()
      })
    })

    it('disables submit button while loading', async () => {
      const user = userEvent.setup()
      mockSignIn.mockReturnValue(new Promise(() => {}))
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.type(screen.getByPlaceholderText(/Enter your password/i), 'password123')
      await user.click(screen.getByRole('button', { name: /sign in/i }))
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled()
      })
    })
  })

  describe('new password challenge', () => {
    it('shows new password form when NewPasswordRequired error occurs', async () => {
      const user = userEvent.setup()
      const mockCognitoUser = { username: 'testuser' }
      mockSignIn.mockRejectedValue({ 
        code: 'NewPasswordRequired', 
        cognitoUser: mockCognitoUser 
      })
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.type(screen.getByPlaceholderText(/Enter your password/i), 'temppassword')
      await user.click(screen.getByRole('button', { name: /sign in/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/Set New Password/i)).toBeInTheDocument()
      })
    })
  })

  describe('forgot password flow', () => {
    it('shows forgot password form when link is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.click(screen.getByText(/forgot password/i))
      
      expect(screen.getByText(/Reset Password/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /send code/i })).toBeInTheDocument()
    })

    it('sends verification code when forgot password form is submitted', async () => {
      const user = userEvent.setup()
      mockForgotPassword.mockResolvedValue({})
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.click(screen.getByText(/forgot password/i))
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.click(screen.getByRole('button', { name: /send code/i }))
      
      await waitFor(() => {
        expect(mockForgotPassword).toHaveBeenCalledWith('testuser')
      })
    })

    it('shows confirmation form after code is sent', async () => {
      const user = userEvent.setup()
      mockForgotPassword.mockResolvedValue({})
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.click(screen.getByText(/forgot password/i))
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.click(screen.getByRole('button', { name: /send code/i }))
      
      await waitFor(() => {
        // After sending code, the form should switch to confirm password mode
        expect(screen.getByText(/Enter Verification Code/i)).toBeInTheDocument()
      })
    })

    it('allows returning to login from forgot password', async () => {
      const user = userEvent.setup()
      
      render(<Login />, { wrapper: createWrapper() })
      
      await user.click(screen.getByText(/forgot password/i))
      await user.click(screen.getByText(/back to login/i))
      
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
    })
  })

  describe('password visibility toggle', () => {
    it('toggles password visibility when eye icon is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Login />, { wrapper: createWrapper() })
      
      const passwordInput = screen.getByPlaceholderText(/Enter your password/i)
      expect(passwordInput).toHaveAttribute('type', 'password')
      
      // The toggle button is inside the same container as the password input
      // eslint-disable-next-line testing-library/no-node-access
      const toggleButton = passwordInput.parentElement!.querySelector('button')!
      expect(toggleButton).toBeInTheDocument()
      
      await user.click(toggleButton)
      expect(passwordInput).toHaveAttribute('type', 'text')
    })
  })

  describe('form validation', () => {
    it('shows error when passwords do not match in new password form', async () => {
      const user = userEvent.setup()
      const mockCognitoUser = { username: 'testuser' }
      mockSignIn.mockRejectedValue({ 
        code: 'NewPasswordRequired', 
        cognitoUser: mockCognitoUser 
      })
      
      render(<Login />, { wrapper: createWrapper() })
      
      // Trigger new password flow
      await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
      await user.type(screen.getByPlaceholderText(/Enter your password/i), 'temppassword')
      await user.click(screen.getByRole('button', { name: /sign in/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/Set New Password/i)).toBeInTheDocument()
      })
      
      // Enter mismatched passwords
      await user.type(screen.getByPlaceholderText(/Enter new password/i), 'newpassword123')
      await user.type(screen.getByPlaceholderText(/Confirm new password/i), 'differentpassword')
      await user.click(screen.getByRole('button', { name: /set password/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/Passwords do not match/i)).toBeInTheDocument()
      })
    })
  })
})
