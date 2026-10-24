import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock amazon-cognito-identity-js
/** The callback object amazon-cognito-identity-js hands its async calls. */
interface CognitoCallbacks {
  onSuccess: (result?: unknown) => void
  onFailure: (error: unknown) => void
}

const mockAuthenticateUser = vi.fn<(details: unknown, callbacks: CognitoCallbacks) => void>()
const mockGetSession = vi.fn()
const mockRefreshSession = vi.fn()
const mockForgotPassword = vi.fn<(callbacks: CognitoCallbacks) => void>()
const mockConfirmPassword = vi.fn<(code: string, newPassword: string, callbacks: CognitoCallbacks) => void>()
const mockCompleteNewPasswordChallenge = vi.fn()
const mockSignOut = vi.fn()

// The implementations MUST be `function`, not arrow, expressions: the source calls
// `new CognitoUserPool(...)` / `new CognitoUser(...)`, and vitest 4 honours `new` with real
// construct semantics, which an arrow function does not support. Vitest 3 invoked the
// implementation as a plain call even under `new`, so an arrow worked there by accident.
vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: vi.fn().mockReturnValue({
        getSession: mockGetSession,
        refreshSession: mockRefreshSession,
        signOut: mockSignOut,
      }),
    }
  }),
  CognitoUser: vi.fn().mockImplementation(function () {
    return {
      authenticateUser: mockAuthenticateUser,
      forgotPassword: mockForgotPassword,
      confirmPassword: mockConfirmPassword,
      completeNewPasswordChallenge: mockCompleteNewPasswordChallenge,
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
      signOut: mockSignOut,
    }
  }),
  AuthenticationDetails: vi.fn(),
  CognitoRefreshToken: vi.fn(),
}))

// Mock config
vi.mock('../runtimeConfig', () => ({
  getRuntimeConfig: () => ({
    apiEndpoint: 'https://api.example.com',
    cognito: {
      userPoolId: 'us-east-1_test123',
      clientId: 'testclientid123',
      region: 'us-east-1',
      identityPoolId: 'us-east-1:test-pool-id',
    },
  }),
  isConfigLoaded: () => true,
  loadRuntimeConfig: vi.fn(),
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

/** What every Cognito call must be handed: both outcomes wired. */
const CALLBACKS: Record<string, unknown> = { onSuccess: expect.any(Function), onFailure: expect.any(Function) }

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

      mockAuthenticateUser.mockImplementation((_authDetails, callbacks) => {
        callbacks.onSuccess(mockSession)
      })

      const result = await authService.signIn('testuser', 'password123')

      expect(mockAuthenticateUser).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(CALLBACKS))
      expect(result).toBe(mockSession)
    })

    it('extracts the Cognito sub into the stored user', async () => {
      const payload = { sub: 'sub-123', 'cognito:username': 'alice', email: 'a@example.com', 'cognito:groups': ['users'] }
      const toBase64Url = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/={1,2}$/, '')
      const idToken = `${toBase64Url({ alg: 'none' })}.${toBase64Url(payload)}.sig`
      const mockSession = {
        getIdToken: () => ({ getJwtToken: () => idToken }),
        getAccessToken: () => ({ getJwtToken: () => 'mock-access-token' }),
        getRefreshToken: () => ({ getToken: () => 'mock-refresh-token' }),
      }
      mockAuthenticateUser.mockImplementation((_authDetails, callbacks) => {
        callbacks.onSuccess(mockSession)
      })

      await authService.signIn('alice', 'password123')

      expect(mockSetUser).toHaveBeenCalledWith(expect.objectContaining({
        username: 'alice', email: 'a@example.com', groups: ['users'], sub: 'sub-123',
      }))
    })

    it('rejects with error on authentication failure', async () => {
      const error = new Error('Incorrect username or password')
      mockAuthenticateUser.mockImplementation((_authDetails, callbacks) => {
        callbacks.onFailure(error)
      })

      await expect(authService.signIn('testuser', 'wrongpassword')).rejects.toThrow('Incorrect username or password')
    })
  })

  describe('signOut', () => {
    it('calls logout on authStore', () => {
      authService.signOut()
      expect(mockLogout).toHaveBeenCalledWith()
    })
  })

  describe('forgotPassword', () => {
    it('initiates forgot password flow', async () => {
      mockForgotPassword.mockImplementation((callbacks) => {
        callbacks.onSuccess({})
      })

      await expect(authService.forgotPassword('testuser')).resolves.not.toThrow()
      expect(mockForgotPassword).toHaveBeenCalledWith(expect.objectContaining(CALLBACKS))
    })
  })

  describe('confirmPassword', () => {
    it('confirms new password with verification code', async () => {
      mockConfirmPassword.mockImplementation((_code, _newPassword, callbacks) => {
        callbacks.onSuccess()
      })

      await expect(authService.confirmPassword('testuser', '123456', 'newpassword')).resolves.not.toThrow()
      expect(mockConfirmPassword).toHaveBeenCalledWith('123456', 'newpassword', expect.objectContaining(CALLBACKS))
    })
  })
})
