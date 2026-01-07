import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock amazon-cognito-identity-js
const mockAuthenticateUser = vi.fn()
const mockGetSession = vi.fn()
const mockRefreshSession = vi.fn()
const mockForgotPassword = vi.fn()
const mockConfirmPassword = vi.fn()
const mockCompleteNewPasswordChallenge = vi.fn()
const mockSignOut = vi.fn()

vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: vi.fn().mockImplementation(() => ({
    getCurrentUser: vi.fn().mockReturnValue({
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
      signOut: mockSignOut,
    }),
  })),
  CognitoUser: vi.fn().mockImplementation(() => ({
    authenticateUser: mockAuthenticateUser,
    forgotPassword: mockForgotPassword,
    confirmPassword: mockConfirmPassword,
    completeNewPasswordChallenge: mockCompleteNewPasswordChallenge,
    getSession: mockGetSession,
    refreshSession: mockRefreshSession,
    signOut: mockSignOut,
  })),
  AuthenticationDetails: vi.fn(),
  CognitoRefreshToken: vi.fn(),
}))

// Mock config
vi.mock('../config', () => ({
  config: {
    cognito: {
      userPoolId: 'us-east-1_test123',
      clientId: 'testclientid123',
    },
  },
}))

// Mock authStore
const mockSetUser = vi.fn()
const mockSetTokens = vi.fn()
const mockLogout = vi.fn()

vi.mock('../store/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      setUser: mockSetUser,
      setTokens: mockSetTokens,
      logout: mockLogout,
      refreshToken: 'mock-refresh-token',
    }),
  },
}))

import { authService } from './auth'

describe('authService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isConfigured', () => {
    it('returns true when Cognito is configured', () => {
      expect(authService.isConfigured()).toBe(true)
    })
  })

  describe('signIn', () => {
    it('calls authenticateUser with correct credentials', async () => {
      const mockSession = {
        getIdToken: () => ({
          getJwtToken: () => 'mock-id-token',
        }),
        getAccessToken: () => ({
          getJwtToken: () => 'mock-access-token',
        }),
        getRefreshToken: () => ({
          getToken: () => 'mock-refresh-token',
        }),
      }

      mockAuthenticateUser.mockImplementation((authDetails, callbacks) => {
        callbacks.onSuccess(mockSession)
      })

      const result = await authService.signIn('testuser', 'password123')

      expect(mockAuthenticateUser).toHaveBeenCalled()
      expect(result).toBe(mockSession)
    })

    it('stores tokens on successful sign in', async () => {
      const mockSession = {
        getIdToken: () => ({
          getJwtToken: () => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjb2duaXRvOnVzZXJuYW1lIjoidGVzdHVzZXIiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJjb2duaXRvOmdyb3VwcyI6WyJhZG1pbnMiXX0.test',
        }),
        getAccessToken: () => ({
          getJwtToken: () => 'mock-access-token',
        }),
        getRefreshToken: () => ({
          getToken: () => 'mock-refresh-token',
        }),
      }

      mockAuthenticateUser.mockImplementation((authDetails, callbacks) => {
        callbacks.onSuccess(mockSession)
      })

      await authService.signIn('testuser', 'password123')

      expect(mockSetTokens).toHaveBeenCalled()
      expect(mockSetUser).toHaveBeenCalled()
    })

    it('rejects with error on authentication failure', async () => {
      const error = new Error('Incorrect username or password')
      mockAuthenticateUser.mockImplementation((authDetails, callbacks) => {
        callbacks.onFailure(error)
      })

      await expect(authService.signIn('testuser', 'wrongpassword')).rejects.toThrow('Incorrect username or password')
    })

    it('handles new password required challenge', async () => {
      mockAuthenticateUser.mockImplementation((authDetails, callbacks) => {
        callbacks.newPasswordRequired({}, [])
      })

      await expect(authService.signIn('testuser', 'temppassword')).rejects.toThrow()
    })
  })

  describe('signOut', () => {
    it('calls logout on authStore', () => {
      authService.signOut()
      expect(mockLogout).toHaveBeenCalled()
    })
  })

  describe('getIdToken', () => {
    it('returns id token from current session', async () => {
      const mockSession = {
        getIdToken: () => ({
          getJwtToken: () => 'mock-id-token',
        }),
        isValid: () => true,
      }

      mockGetSession.mockImplementation((callback) => {
        callback(null, mockSession)
      })

      const token = await authService.getIdToken()
      expect(token).toBe('mock-id-token')
    })

    it('returns null when no session', async () => {
      mockGetSession.mockImplementation((callback) => {
        callback(new Error('No session'), null)
      })

      const token = await authService.getIdToken()
      expect(token).toBeNull()
    })
  })

  describe('getAccessToken', () => {
    it('returns access token from current session', async () => {
      const mockSession = {
        getAccessToken: () => ({
          getJwtToken: () => 'mock-access-token',
        }),
        isValid: () => true,
      }

      mockGetSession.mockImplementation((callback) => {
        callback(null, mockSession)
      })

      const token = await authService.getAccessToken()
      expect(token).toBe('mock-access-token')
    })
  })

  describe('refreshSession', () => {
    it('refreshes tokens using refresh token', async () => {
      const mockSession = {
        getIdToken: () => ({
          getJwtToken: () => 'new-id-token',
        }),
        getAccessToken: () => ({
          getJwtToken: () => 'new-access-token',
        }),
        getRefreshToken: () => ({
          getToken: () => 'new-refresh-token',
        }),
      }

      mockRefreshSession.mockImplementation((refreshToken, callback) => {
        callback(null, mockSession)
      })

      const result = await authService.refreshSession()
      expect(result).toBe(mockSession)
    })

    it('rejects when refresh fails', async () => {
      mockRefreshSession.mockImplementation((refreshToken, callback) => {
        callback(new Error('Token expired'), null)
      })

      await expect(authService.refreshSession()).rejects.toThrow()
    })
  })

  describe('forgotPassword', () => {
    it('initiates forgot password flow', async () => {
      mockForgotPassword.mockImplementation((callbacks) => {
        callbacks.onSuccess({})
      })

      await expect(authService.forgotPassword('testuser')).resolves.not.toThrow()
      expect(mockForgotPassword).toHaveBeenCalled()
    })

    it('rejects on failure', async () => {
      mockForgotPassword.mockImplementation((callbacks) => {
        callbacks.onFailure(new Error('User not found'))
      })

      await expect(authService.forgotPassword('unknownuser')).rejects.toThrow('User not found')
    })
  })

  describe('confirmPassword', () => {
    it('confirms new password with verification code', async () => {
      mockConfirmPassword.mockImplementation((code, newPassword, callbacks) => {
        callbacks.onSuccess()
      })

      await expect(authService.confirmPassword('testuser', '123456', 'newpassword')).resolves.not.toThrow()
      expect(mockConfirmPassword).toHaveBeenCalled()
    })

    it('rejects on invalid code', async () => {
      mockConfirmPassword.mockImplementation((code, newPassword, callbacks) => {
        callbacks.onFailure(new Error('Invalid verification code'))
      })

      await expect(authService.confirmPassword('testuser', 'wrongcode', 'newpassword')).rejects.toThrow('Invalid verification code')
    })
  })

  describe('completeNewPassword', () => {
    it('completes new password challenge', async () => {
      const mockSession = {
        getIdToken: () => ({ getJwtToken: () => 'mock-id-token' }),
        getAccessToken: () => ({ getJwtToken: () => 'mock-access-token' }),
        getRefreshToken: () => ({ getToken: () => 'mock-refresh-token' }),
      }

      mockCompleteNewPasswordChallenge.mockImplementation((newPassword, attrs, callbacks) => {
        callbacks.onSuccess(mockSession)
      })

      const result = await authService.completeNewPassword('testuser', 'newpassword')
      expect(result).toBe(mockSession)
    })

    it('rejects on failure', async () => {
      mockCompleteNewPasswordChallenge.mockImplementation((newPassword, attrs, callbacks) => {
        callbacks.onFailure(new Error('Password does not meet requirements'))
      })

      await expect(authService.completeNewPassword('testuser', 'weak')).rejects.toThrow('Password does not meet requirements')
    })
  })

  describe('getCurrentUser', () => {
    it('returns current authenticated user', () => {
      const user = authService.getCurrentUser()
      expect(user).toBeDefined()
    })
  })

  describe('isAuthenticated', () => {
    it('returns true when session is valid', async () => {
      const mockSession = {
        isValid: () => true,
      }

      mockGetSession.mockImplementation((callback) => {
        callback(null, mockSession)
      })

      const isAuth = await authService.isAuthenticated()
      expect(isAuth).toBe(true)
    })

    it('returns false when no session', async () => {
      mockGetSession.mockImplementation((callback) => {
        callback(new Error('No session'), null)
      })

      const isAuth = await authService.isAuthenticated()
      expect(isAuth).toBe(false)
    })
  })
})
