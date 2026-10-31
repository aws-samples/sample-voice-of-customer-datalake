/**
 * The app pool's sign-in service against a mocked `aws-amplify/auth`: what each call hands
 * Amplify, what reaches authStore, and how challenges, refreshes and sign-out behave.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SignInOutput } from 'aws-amplify/auth'
import { fakeJwt } from '@test/fakeJwt'

const amplify = vi.hoisted(() => ({
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  fetchAuthSession: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
  updatePassword: vi.fn(),
}))
vi.mock('aws-amplify/auth', () => amplify)

const cognitoConfig = vi.hoisted(() => ({ userPoolId: 'us-east-1_test123', clientId: 'testclientid123' }))
vi.mock('../runtimeConfig', () => ({
  getRuntimeConfig: () => ({
    apiEndpoint: 'https://api.example.com',
    cognito: { ...cognitoConfig, region: 'us-east-1', identityPoolId: 'us-east-1:test-pool-id' },
  }),
  isConfigLoaded: () => true,
  loadRuntimeConfig: vi.fn(),
}))

const configureAmplify = vi.hoisted(() => vi.fn())
vi.mock('../lib/amplify-config', () => ({ configureAmplify }))

const store = vi.hoisted(() => ({ setUser: vi.fn(), setTokens: vi.fn(), logout: vi.fn(), idToken: 'stored-id' }))
vi.mock('../store/authStore', () => ({ useAuthStore: { getState: () => store } }))

import {
  AuthChallengeError, NO_SESSION_AFTER_SIGN_IN, UNSUPPORTED_SIGN_IN_STEP, authService,
  isNewPasswordChallenge,
} from './auth'

const ID_TOKEN = fakeJwt({ sub: 'sub-123', 'cognito:username': 'alice', email: 'a@example.com', 'cognito:groups': ['users'] })
const ACCESS_TOKEN = fakeJwt({ token_use: 'access' })

/** A `fetchAuthSession` answer holding tokens (only `toString()` is read). */
const sessionWithTokens = () => ({ tokens: { idToken: { toString: () => ID_TOKEN }, accessToken: { toString: () => ACCESS_TOKEN } } })

/** Amplify sign-in answers for the steps the service tells apart. */
const DONE: SignInOutput = { isSignedIn: true, nextStep: { signInStep: 'DONE' } }
const NEW_PASSWORD: SignInOutput = {
  isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
}
const TOTP: SignInOutput = { isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } }

/** The rejection of `promise` (fails the test when it resolves). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  vi.clearAllMocks()
  cognitoConfig.userPoolId = 'us-east-1_test123'
  amplify.fetchAuthSession.mockResolvedValue(sessionWithTokens())
  amplify.signOut.mockResolvedValue(undefined)
})

describe('isConfigured', () => {
  it('is true with a user pool and client id, false without', () => {
    expect(authService.isConfigured()).toBe(true)
    cognitoConfig.userPoolId = ''
    expect(authService.isConfigured()).toBe(false)
  })
})

describe('signIn', () => {
  it('signs in with Amplify and stores the session tokens and user', async () => {
    amplify.signIn.mockResolvedValue(DONE)

    await authService.signIn('alice', 'password123')

    expect(amplify.signIn).toHaveBeenCalledWith({ username: 'alice', password: 'password123' })
    expect(amplify.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: false })
    expect(store.setTokens).toHaveBeenCalledWith({ accessToken: ACCESS_TOKEN, idToken: ID_TOKEN })
    expect(store.setUser).toHaveBeenCalledWith({
      username: 'alice', email: 'a@example.com', name: undefined, groups: ['users'], sub: 'sub-123',
    })
  })

  it('configures Amplify before signing in, whatever ran first', async () => {
    amplify.signIn.mockImplementation(() => {
      expect(configureAmplify).toHaveBeenCalledWith()
      return Promise.resolve(DONE)
    })

    await authService.signIn('alice', 'password123')

    expect(amplify.signIn).toHaveBeenCalledTimes(1)
  })

  it('refuses a DONE sign-in that left no tokens, as its own error', async () => {
    amplify.signIn.mockResolvedValue(DONE)
    amplify.fetchAuthSession.mockResolvedValue({ tokens: undefined })

    const error = await rejectionOf(authService.signIn('alice', 'password123'))

    expect(error).toHaveProperty('code', NO_SESSION_AFTER_SIGN_IN)
    expect(store.setTokens).not.toHaveBeenCalled()
  })

  it('rejects with the Cognito error when sign-in fails', async () => {
    const refused = Object.assign(new Error('Incorrect username or password.'), { name: 'NotAuthorizedException' })
    amplify.signIn.mockRejectedValue(refused)

    await expect(authService.signIn('alice', 'wrong')).rejects.toBe(refused)
    expect(store.setTokens).not.toHaveBeenCalled()
  })

  it('rejects with NewPasswordRequired for the first-login challenge, storing nothing', async () => {
    amplify.signIn.mockResolvedValue(NEW_PASSWORD)

    const error = await rejectionOf(authService.signIn('alice', 'temporary'))

    expect(error).toBeInstanceOf(AuthChallengeError)
    expect(isNewPasswordChallenge(error)).toBe(true)
    expect(store.setTokens).not.toHaveBeenCalled()
  })

  it('refuses a step the page does not offer (MFA)', async () => {
    amplify.signIn.mockResolvedValue(TOTP)

    const error = await rejectionOf(authService.signIn('alice', 'password123'))

    expect(error).toHaveProperty('code', UNSUPPORTED_SIGN_IN_STEP)
    expect(isNewPasswordChallenge(error)).toBe(false)
    expect(store.setTokens).not.toHaveBeenCalled()
  })

  it('signs a leftover Amplify session out, then signs in once more', async () => {
    const already = Object.assign(new Error('There is already a signed in user.'), { name: 'UserAlreadyAuthenticatedException' })
    amplify.signIn.mockRejectedValueOnce(already).mockResolvedValueOnce(DONE)

    await authService.signIn('alice', 'password123')

    expect(amplify.signOut).toHaveBeenCalledTimes(1)
    expect(amplify.signIn).toHaveBeenCalledTimes(2)
    expect(store.setTokens).toHaveBeenCalledTimes(1)
  })

  it('waits for a sign-out still revoking before it signs in', async () => {
    const order: string[] = []
    amplify.signOut.mockImplementation(async () => { await Promise.resolve(); order.push('signOut') })
    amplify.signIn.mockImplementation(() => { order.push('signIn'); return Promise.resolve(DONE) })

    authService.signOut()
    await authService.signIn('alice', 'password123')

    expect(order).toStrictEqual(['signOut', 'signIn'])
  })

  it('refuses with a ConfigError when Cognito is not configured', async () => {
    cognitoConfig.userPoolId = ''
    await expect(authService.signIn('alice', 'password123')).rejects.toThrow('Cognito not configured')
    expect(amplify.signIn).not.toHaveBeenCalled()
  })
})

describe('completeNewPassword', () => {
  it('answers the challenge and stores the session', async () => {
    amplify.confirmSignIn.mockResolvedValue(DONE)

    await authService.completeNewPassword('NewPassword!1')

    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: 'NewPassword!1' })
    expect(store.setTokens).toHaveBeenCalledWith({ accessToken: ACCESS_TOKEN, idToken: ID_TOKEN })
  })
})

describe('refreshSession', () => {
  it('forces a refresh and stores the new tokens', async () => {
    await authService.refreshSession()

    expect(amplify.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true })
    expect(store.setTokens).toHaveBeenCalledWith({ accessToken: ACCESS_TOKEN, idToken: ID_TOKEN })
    expect(store.logout).not.toHaveBeenCalled()
  })

  it('signs out and rejects when there is no session to refresh', async () => {
    amplify.fetchAuthSession.mockResolvedValue({ tokens: undefined })

    await expect(authService.refreshSession()).rejects.toThrow('please sign in again')
    expect(store.logout).toHaveBeenCalledTimes(1)
  })

  it('signs out and rejects when the refresh fails', async () => {
    amplify.fetchAuthSession.mockRejectedValue(new Error('Network error'))

    await expect(authService.refreshSession()).rejects.toThrow('Network error')
    expect(store.logout).toHaveBeenCalledTimes(1)
    expect(store.setTokens).not.toHaveBeenCalled()
  })
})

describe('signOut', () => {
  it('clears authStore at once and signs Amplify out behind it', async () => {
    authService.signOut()

    expect(store.logout).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(amplify.signOut).toHaveBeenCalledWith())
  })

  it('swallows a failed revoke (the local tokens are cleared regardless)', async () => {
    amplify.signOut.mockRejectedValue(new Error('offline'))
    authService.signOut()
    amplify.signIn.mockResolvedValue(DONE)

    await expect(authService.signIn('alice', 'password123')).resolves.toBeUndefined()
  })
})

describe('getIdToken', () => {
  it('reads the ID token from authStore', () => {
    expect(authService.getIdToken()).toBe('stored-id')
  })
})

describe('password reset and change', () => {
  it('forgotPassword emails a reset code', async () => {
    amplify.resetPassword.mockResolvedValue({})
    await authService.forgotPassword('alice')
    expect(amplify.resetPassword).toHaveBeenCalledWith({ username: 'alice' })
  })

  it('confirmPassword sets the new password with the code', async () => {
    amplify.confirmResetPassword.mockResolvedValue(undefined)
    await authService.confirmPassword('alice', '123456', 'NewPassword!1')
    expect(amplify.confirmResetPassword).toHaveBeenCalledWith({
      username: 'alice', confirmationCode: '123456', newPassword: 'NewPassword!1',
    })
  })

  it('changePassword passes the Cognito refusal through (the page words "Incorrect")', async () => {
    const refused = new Error('Incorrect username or password.')
    amplify.updatePassword.mockRejectedValue(refused)

    await expect(authService.changePassword('old', 'NewPassword!1')).rejects.toBe(refused)
    expect(amplify.updatePassword).toHaveBeenCalledWith({ oldPassword: 'old', newPassword: 'NewPassword!1' })
  })
})
