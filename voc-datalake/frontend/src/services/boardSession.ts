/**
 * @fileoverview The signed-in board-pool session in this browser: stored, read, refreshed, forgotten.
 *
 * Kept apart from Amplify, which holds the APP user pool (one pool per page). The keys are the
 * ones amazon-cognito-identity-js used (`CognitoIdentityServiceProvider.<board client id>.LastAuthUser`
 * and `.<email>.idToken|accessToken|refreshToken`), so a board session signed in before the
 * migration keeps working, and they never collide with the app pool's (another client id).
 *
 * A read returns the stored ID token while it is valid; an expired (or forced) one is refreshed
 * with `REFRESH_TOKEN_AUTH`, one refresh at a time. Cognito refusing the refresh token signs the
 * board user out; a transport failure keeps the session for the next try.
 *
 * @module services/boardSession
 */
import { jwtExpiresAt, jwtPayload } from '../lib/jwt'
import { CognitoRefusal, refreshedTokensOf, type AuthTokens } from './boardCognito'

/** The part of `Storage` the session uses (localStorage, or an in-memory double in tests). */
export interface SessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** A token closer than this to its expiry is refreshed before use. */
const EXPIRY_MARGIN_MS = 30_000

/** Refusals that mean the refresh token is dead (not a passing failure). */
const DEAD_SESSION_ERRORS = new Set(['NotAuthorizedException', 'UserNotFoundException', 'TokenRevokedException'])

const TOKEN_KEYS = ['idToken', 'accessToken', 'refreshToken', 'clockDrift'] as const

export interface BoardSessionDeps {
  readonly clientId: string
  readonly storage: SessionStorage
  readonly now: () => number
  /** One Cognito call (the board's own `fetch` wrapper): the parsed body, or a thrown CognitoRefusal. */
  readonly call: (target: string, payload: object) => Promise<unknown>
}

export function createBoardSession({ clientId, storage, now, call }: BoardSessionDeps) {
  const prefix = `CognitoIdentityServiceProvider.${clientId}`
  const lastUserKey = `${prefix}.LastAuthUser`
  const keyOf = (user: string, name: (typeof TOKEN_KEYS)[number]) => `${prefix}.${user}.${name}`
  const inflight: { refresh: Promise<string | null> | null } = { refresh: null }

  function currentUser(): string | null {
    const user = storage.getItem(lastUserKey)
    return user === null || user === '' ? null : user
  }

  function clear(): void {
    const user = currentUser()
    if (user !== null) for (const name of TOKEN_KEYS) storage.removeItem(keyOf(user, name))
    storage.removeItem(lastUserKey)
  }

  function save(user: string, tokens: AuthTokens): void {
    if (currentUser() !== user) clear()
    storage.setItem(keyOf(user, 'idToken'), tokens.IdToken)
    storage.setItem(keyOf(user, 'accessToken'), tokens.AccessToken)
    storage.setItem(keyOf(user, 'refreshToken'), tokens.RefreshToken)
    storage.setItem(lastUserKey, user)
  }

  const fresh = (token: string | null): token is string =>
    token !== null && jwtExpiresAt(token) > now() + EXPIRY_MARGIN_MS

  async function refresh(user: string): Promise<string | null> {
    const refreshToken = storage.getItem(keyOf(user, 'refreshToken'))
    if (refreshToken === null || refreshToken === '') {
      clear()
      return null
    }
    try {
      const tokens = refreshedTokensOf(await call('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken },
      }), refreshToken)
      if (tokens === null) return null
      save(user, tokens)
      return tokens.IdToken
    } catch (error) {
      if (error instanceof CognitoRefusal && DEAD_SESSION_ERRORS.has(error.type)) clear()
      return null
    }
  }

  /** One refresh at a time: concurrent readers share it (a rotated refresh token is used once). */
  function sharedRefresh(user: string): Promise<string | null> {
    inflight.refresh ??= refresh(user).finally(() => { inflight.refresh = null })
    return inflight.refresh
  }

  async function idToken(forceRefresh = false): Promise<string | null> {
    const user = currentUser()
    if (user === null) return null
    const stored = storage.getItem(keyOf(user, 'idToken'))
    if (!forceRefresh && fresh(stored)) return stored
    return sharedRefresh(user)
  }

  async function email(): Promise<string | null> {
    const token = await idToken()
    const claim = token === null ? undefined : jwtPayload(token)['email']
    return typeof claim === 'string' && claim !== '' ? claim : null
  }

  return {
    /** Store a fresh sign-in's tokens as THE board session of this browser (replacing another user's). */
    save,
    /** Forget the board session in this browser. */
    clear,
    /** The signed-in board user's ID token, refreshed when (nearly) expired or forced; null when signed out. */
    idToken,
    /** The `email` claim of a valid session's ID token, or null. */
    email,
  }
}
