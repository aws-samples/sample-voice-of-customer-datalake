/**
 * @fileoverview Sign-in to the app user pool with Amplify v6 (`aws-amplify/auth`).
 *
 * - Sign in with username/password (SRP), including the first-login new-password challenge
 * - Token refresh (Amplify refreshes with the refresh token it keeps, de-duplicating
 *   concurrent refreshes)
 * - Password reset (forgot password + confirmation) and password change
 *
 * Where tokens live:
 * - Amplify's token store (localStorage, `CognitoIdentityServiceProvider.<client id>.*` keys, the
 *   same keys the former amazon-cognito-identity-js session used, so a session signed in before
 *   the migration keeps working) holds the ID, access and refresh tokens. A new tab refreshes
 *   from there without signing in again.
 * - `authStore` mirrors the short-lived ID and access tokens and the user they identify, for
 *   synchronous reads (`getIdToken`) and rendering. It never holds the refresh token.
 *
 * @module services/auth
 */

import {
  confirmResetPassword, confirmSignIn, fetchAuthSession, resetPassword, signIn as amplifySignIn,
  signOut as amplifySignOut, updatePassword, type SignInInput, type SignInOutput,
} from 'aws-amplify/auth'
import { configureAmplify } from '../lib/amplify-config'
import { AuthError, ConfigError } from '../lib/errors'
import { jwtPayload } from '../lib/jwt'
import { ignoreRejection } from '../lib/rejections'
import { getRuntimeConfig } from '../runtimeConfig'
import { useAuthStore } from '../store/authStore'
import type { User } from '../store/authStore'
import { PasskeyError, toPasskeyError } from './passkey'

/** The code of the first-login challenge (the new-password form). */
export const NEW_PASSWORD_REQUIRED = 'NewPasswordRequired'
/** A sign-in step the page does not offer (MFA, a sign-up confirmation, a reset): Login shows its generic failure. */
export const UNSUPPORTED_SIGN_IN_STEP = 'UnsupportedSignInStep'
/** Cognito answered DONE but Amplify holds no tokens afterwards. */
export const NO_SESSION_AFTER_SIGN_IN = 'NoSessionAfterSignIn'

/** An AuthError carrying the code Login switches on. */
export class AuthChallengeError extends AuthError {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AuthChallengeError'
    this.code = code
  }
}

/** Whether a `signIn` rejection is the first-login challenge (answer it with `completeNewPassword`). */
export function isNewPasswordChallenge(error: unknown): boolean {
  return error instanceof AuthChallengeError && error.code === NEW_PASSWORD_REQUIRED
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Extracts user information from a Cognito ID token.
 * @param idToken - The JWT ID token from Cognito
 * @returns User object with username, email, name, groups and sub
 */
const extractUser = (idToken: string): User => {
  const payload = jwtPayload(idToken)
  const username = payload['cognito:username']
  const email = payload['email']
  const name = payload['name']
  const groups = payload['cognito:groups']
  const sub = payload['sub']

  return {
    username: isString(username) ? username : '',
    email: isString(email) ? email : '',
    name: isString(name) ? name : undefined,
    groups: isStringArray(groups) ? groups : [],
    sub: isString(sub) && sub !== '' ? sub : undefined,
  }
}

const isConfigured = (): boolean => {
  const cfg = getRuntimeConfig()
  return cfg.cognito.userPoolId !== '' && cfg.cognito.clientId !== ''
}

/** Throws a ConfigError without a pool; else makes sure Amplify is configured (idempotent), whatever ran first. */
const requireConfigured = (): void => {
  if (!isConfigured()) throw new ConfigError('Cognito not configured')
  configureAmplify()
}

/**
 * Copies the tokens Amplify holds into authStore. `forceRefresh` asks Cognito for new ones first.
 * @returns whether there was a session to copy
 */
async function storeCurrentTokens(forceRefresh: boolean): Promise<boolean> {
  const { tokens } = await fetchAuthSession({ forceRefresh })
  if (tokens?.idToken === undefined) return false
  const idToken = tokens.idToken.toString()
  useAuthStore.getState().setTokens({ accessToken: tokens.accessToken.toString(), idToken })
  useAuthStore.getState().setUser(extractUser(idToken))
  return true
}

/** The sign-out still talking to Cognito (revoking the refresh token); a sign-in waits for it. */
const signOutState: { pending: Promise<void> } = { pending: Promise.resolve() }

/**
 * Amplify's local sign-out, never rejecting: Amplify clears its local tokens even when revoking the
 * refresh token fails (offline), and a failed revoke leaves nothing to show the user.
 */
function startSignOut(): Promise<void> {
  const pending = signOutState.pending.then(() => amplifySignOut()).catch(ignoreRejection)
  signOutState.pending = pending
  return pending
}

/** Turns a sign-in step into a stored session, or the error Login shows. */
async function finishSignIn(output: SignInOutput): Promise<void> {
  const step = output.nextStep.signInStep
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
    throw new AuthChallengeError(NEW_PASSWORD_REQUIRED, 'New password required')
  }
  if (step !== 'DONE') {
    // MFA, a sign-up confirmation or a reset are not offered by the app pool's sign-in page.
    throw new AuthChallengeError(UNSUPPORTED_SIGN_IN_STEP, `Sign-in needs a step this page does not support (${step})`)
  }
  if (!(await storeCurrentTokens(false))) {
    throw new AuthChallengeError(NO_SESSION_AFTER_SIGN_IN, 'Sign-in finished without a session')
  }
}

const isAlreadySignedIn = (error: unknown): boolean =>
  error instanceof Error && error.name === 'UserAlreadyAuthenticatedException'

/**
 * Amplify's sign-in; when Amplify still holds a session (authStore was cleared without a sign-out)
 * that session is signed out first and the sign-in tried once more.
 */
async function signInFresh(input: SignInInput): Promise<SignInOutput> {
  try {
    return await amplifySignIn(input)
  } catch (error) {
    if (!isAlreadySignedIn(error)) throw error
    await startSignOut()
    return amplifySignIn(input)
  }
}

/**
 * Authentication service for the app user pool.
 */
export const authService = {
  /** Whether the user pool id and client id are set. */
  isConfigured,

  /**
   * Signs in with username (or email) and password. On success the tokens are in authStore.
   * A session Amplify still holds (the store was cleared without a sign-out) is signed out first.
   *
   * @throws AuthChallengeError with code `NewPasswordRequired` when the password must change first
   *   (finish with `completeNewPassword`)
   * @throws the Cognito error (its `message` is shown) when sign-in fails
   */
  signIn: async (username: string, password: string): Promise<void> => {
    requireConfigured()
    await signOutState.pending
    await finishSignIn(await signInFresh({ username, password }))
  },

  /**
   * Signs in with a passkey: Amplify's choice-based `USER_AUTH` flow preferring `WEB_AUTHN` asks the
   * browser for the passkey and answers Cognito's challenge. On success the tokens are in authStore,
   * exactly as after a password sign-in.
   * @throws PasskeyError: `no_passkey` when Cognito offers another challenge (none is registered),
   *   `cancelled` / `unsupported` / `unknown` for the browser or service failure
   */
  signInWithPasskey: async (username: string): Promise<void> => {
    requireConfigured()
    await signOutState.pending
    const output = await signInFresh({
      username: username.trim(),
      options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' },
    }).catch((error: unknown) => { throw toPasskeyError(error) })
    // Without a passkey Cognito offers the other first factors instead of WebAuthn: abandon that
    // half-started sign-in. Any other step (a new password, an unsupported one) is the password
    // sign-in's own answer.
    if (output.nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') {
      await startSignOut()
      throw new PasskeyError('no_passkey')
    }
    await finishSignIn(output)
  },

  /**
   * Answers the new-password challenge of the sign-in that just threw `NewPasswordRequired`
   * (Amplify keeps that challenge in memory, so it must be the same page load).
   */
  completeNewPassword: async (newPassword: string): Promise<void> => {
    requireConfigured()
    await finishSignIn(await confirmSignIn({ challengeResponse: newPassword }))
  },

  /**
   * Signs out: authStore is cleared at once; Amplify revokes the refresh token and clears its
   * own storage in the background (a sign-in started meanwhile waits for it).
   */
  signOut: (): void => {
    useAuthStore.getState().logout()
    if (!isConfigured()) return
    configureAmplify()
    void startSignOut()
  },

  /**
   * Gets new tokens from Cognito with the refresh token Amplify holds (also in a new tab).
   * @throws AuthError, after clearing authStore, when there is no session to refresh or Cognito
   *   refuses it (also for a transport failure, which callers treat the same way)
   */
  refreshSession: async (): Promise<void> => {
    requireConfigured()
    const refreshed = await storeCurrentTokens(true).catch((error: unknown) => {
      useAuthStore.getState().logout()
      throw error instanceof Error ? error : new AuthError(String(error))
    })
    if (!refreshed) {
      useAuthStore.getState().logout()
      throw new AuthError('No session available — please sign in again')
    }
  },

  /** The current ID token from authStore, or null when signed out. */
  getIdToken: (): string | null => {
    return useAuthStore.getState().idToken
  },

  /** Emails a verification code for a password reset. */
  forgotPassword: async (username: string): Promise<void> => {
    requireConfigured()
    await resetPassword({ username })
  },

  /** Sets a new password with the emailed verification code. */
  confirmPassword: async (username: string, code: string, newPassword: string): Promise<void> => {
    requireConfigured()
    await confirmResetPassword({ username, confirmationCode: code, newPassword })
  },

  /**
   * Changes the signed-in user's password.
   * @throws the Cognito error (e.g. "Incorrect username or password.") when the change fails
   */
  changePassword: async (oldPassword: string, newPassword: string): Promise<void> => {
    requireConfigured()
    await updatePassword({ oldPassword, newPassword })
  },
}
