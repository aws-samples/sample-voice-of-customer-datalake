/**
 * @fileoverview Tests for Login page component.
 * @module pages/Login
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'

// Mock auth service
const mockSignIn = vi.fn<(...args: unknown[]) => unknown>()
const mockCompleteNewPassword = vi.fn<(...args: unknown[]) => unknown>()
const mockForgotPassword = vi.fn<(...args: unknown[]) => unknown>()
const mockConfirmPassword = vi.fn<(...args: unknown[]) => unknown>()

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
// Mutable so a test can arrive here the way an expired session does.
const mockLocation: { value: { state?: unknown; search: string } } = {
  value: { state: { from: '/dashboard' }, search: '' },
}
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation.value,
  }
})

import Login from './Login'


type User = ReturnType<typeof userEvent.setup>

/** Renders the page with a no-retry query client inside its router. */
function renderLogin() {
  return renderWithQueryClient(<TestRouter initialEntries={['/login']}><Login /></TestRouter>)
}

/** Fill both credential fields and press Sign In. */
async function submitCredentials(user: User, username: string, password: string) {
  await user.type(screen.getByPlaceholderText(/Enter your username/i), username)
  await user.type(screen.getByPlaceholderText(/Enter your password/i), password)
  await user.click(screen.getByRole('button', { name: /sign in/i }))
}

/** Render and sign in with `password`, handing back the user for what follows. */
async function renderAndSignIn(password: string) {
  const user = userEvent.setup()
  renderLogin()
  await submitCredentials(user, 'testuser', password)
  return user
}

/** Sign in against a NewPasswordRequired challenge and land on the new-password form. */
async function expectNewPasswordChallenge() {
  const mockCognitoUser = { username: 'testuser' }
  mockSignIn.mockRejectedValue({ 
    code: 'NewPasswordRequired', 
    cognitoUser: mockCognitoUser 
  })
  const user = await renderAndSignIn('temppassword')
  await waitFor(() => {
    expect(screen.getByText(/Set New Password/i)).toBeInTheDocument()
  })
  return user
}

/** Render and click through to the forgot-password form. */
async function openForgotPassword() {
  const user = userEvent.setup()
  renderLogin()
  await user.click(screen.getByText(/forgot password/i))
  return user
}

/** Open forgot-password, enter the username and request a code. */
async function requestResetCode() {
  mockForgotPassword.mockResolvedValue({})
  const user = await openForgotPassword()
  await user.type(screen.getByPlaceholderText(/Enter your username/i), 'testuser')
  await user.click(screen.getByRole('button', { name: /send code/i }))
  return user
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLocation.value = { state: { from: '/dashboard' }, search: '' }
  })

  /*
   * Landing here because a session died is not the same as landing here to
   * sign in. Without the notice, an app that was working a moment ago simply
   * becomes a login form with no explanation.
   */
  describe('expired-session notice', () => {
    it('explains itself when redirected by an expired session', () => {
      mockLocation.value = { search: '?expired=1' }

      renderLogin()

      expect(screen.getByText(/session expired/i)).toBeInTheDocument()
    })

    it('says nothing on an ordinary visit', () => {
      renderLogin()

      expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument()
    })

    it('yields to a real submit error', async () => {
      mockLocation.value = { search: '?expired=1' }
      mockSignIn.mockRejectedValue(new Error('Incorrect username or password'))

      await renderAndSignIn('wrong')

      await waitFor(() => {
        expect(screen.getByText(/incorrect username or password/i)).toBeInTheDocument()
      })
      expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument()
    })
  })

  describe('initial render', () => {
    it('displays VoC Analytics branding', () => {
      renderLogin()
      
      expect(screen.getByText('VoC Analytics')).toBeInTheDocument()
      expect(screen.getByText('Voice of the Customer Analytics')).toBeInTheDocument()
    })

    it('displays login form with username and password fields', () => {
      renderLogin()
      
      expect(screen.getByPlaceholderText(/Enter your username/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/Enter your password/i)).toBeInTheDocument()
    })

    it('displays sign in button', () => {
      renderLogin()
      
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
    })

    it('displays forgot password link', () => {
      renderLogin()
      
      expect(screen.getByText(/forgot password/i)).toBeInTheDocument()
    })

    it('displays contact administrator message', () => {
      renderLogin()
      
      expect(screen.getByText(/Contact your administrator/i)).toBeInTheDocument()
    })
  })

  describe('login form submission', () => {
    it('calls signIn with username and password on submit', async () => {
      mockSignIn.mockResolvedValue({})
      
      await renderAndSignIn('password123')
      
      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalledWith('testuser', 'password123')
      })
    })

    it('navigates to original destination after successful login', async () => {
      mockSignIn.mockResolvedValue({})
      
      await renderAndSignIn('password123')
      
      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true })
      })
    })

    it('marks a sign-in to "/" as a landing, so Home can honour the start page', async () => {
      mockLocation.value = { state: null, search: '' }
      mockSignIn.mockResolvedValue({})

      await renderAndSignIn('password123')

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true, state: { landing: true } })
      })
    })

    it('displays error message on login failure', async () => {
      mockSignIn.mockRejectedValue({ message: 'Invalid credentials' })
      
      await renderAndSignIn('wrongpassword')
      
      await waitFor(() => {
        expect(screen.getByText('Invalid credentials')).toBeInTheDocument()
      })
    })

    it('disables submit button while loading', async () => {
      mockSignIn.mockReturnValue(new Promise(() => {}))
      
      await renderAndSignIn('password123')
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled()
      })
    })
  })

  describe('new password challenge', () => {
    it('shows new password form when NewPasswordRequired error occurs', async () => {
      await expectNewPasswordChallenge()
    })
  })

  describe('forgot password flow', () => {
    it('shows forgot password form when link is clicked', async () => {
      await openForgotPassword()
      
      expect(screen.getByText(/Reset Password/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /send code/i })).toBeInTheDocument()
    })

    it('sends verification code when forgot password form is submitted', async () => {
      await requestResetCode()
      
      await waitFor(() => {
        expect(mockForgotPassword).toHaveBeenCalledWith('testuser')
      })
    })

    it('shows confirmation form after code is sent', async () => {
      await requestResetCode()
      
      await waitFor(() => {
        // After sending code, the form should switch to confirm password mode
        expect(screen.getByText(/Enter Verification Code/i)).toBeInTheDocument()
      })
    })

    it('allows returning to login from forgot password', async () => {
      const user = await openForgotPassword()
      await user.click(screen.getByText(/back to login/i))
      
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
    })
  })

  describe('password visibility toggle', () => {
    it('toggles password visibility when eye icon is clicked', async () => {
      const user = userEvent.setup()
      
      renderLogin()
      
      const passwordInput = screen.getByPlaceholderText(/Enter your password/i)
      expect(passwordInput).toHaveAttribute('type', 'password')
      
      await user.click(screen.getByRole('button', { name: 'Show password' }))
      expect(passwordInput).toHaveAttribute('type', 'text')
    })

    it('names the toggle and the fields for assistive tech', async () => {
      const user = userEvent.setup()
      renderLogin()

      expect(screen.getByRole('main')).toBeInTheDocument()
      expect(screen.getByLabelText('Username or Email')).toHaveAttribute('autocomplete', 'username')
      expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')

      await user.click(screen.getByRole('button', { name: 'Show password' }))
      expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('form validation', () => {
    it('shows error when passwords do not match in new password form', async () => {
      // Trigger new password flow
      const user = await expectNewPasswordChallenge()
      
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
