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
  getConfig: () => ({
    apiEndpoint: 'https://api.example.com',
    cognito: {
      userPoolId: 'us-east-1_test123',
      clientId: 'testclientid123',
      region: 'us-east-1',
    },
  }),
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
    it('calls authenticateUser with credentials', async () => {
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

    it('rejects with error on authentication failure', async () => {
      const error = new Error('Incorrect username or password')
      mockAuthenticateUser.mockImplementation((authDetails, callbacks) => {
        callbacks.onFailure(error)
      })

      await expect(authService.signIn('testuser', 'wrongpassword')).rejects.toThrow('Incorrect username or password')
    })
  })

  describe('signOut', () => {
    it('calls logout on authStore', () => {
      authService.signOut()
      expect(mockLogout).toHaveBeenCalled()
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
  })

  describe('confirmPassword', () => {
    it('confirms new password with verification code', async () => {
      mockConfirmPassword.mockImplementation((code, newPassword, callbacks) => {
        callbacks.onSuccess()
      })

      await expect(authService.confirmPassword('testuser', '123456', 'newpassword')).resolves.not.toThrow()
      expect(mockConfirmPassword).toHaveBeenCalled()
    })
  })
})
