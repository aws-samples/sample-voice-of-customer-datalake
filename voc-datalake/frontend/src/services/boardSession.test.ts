/**
 * The board-pool session store against an in-memory storage and a scripted Cognito call:
 * legacy key layout, refresh on expiry, rotation, dead and transient refresh failures.
 */
import { describe, it, expect, vi } from 'vitest'
import { fakeJwt } from '@test/fakeJwt'
import { CognitoRefusal } from './boardCognito'
import { createBoardSession } from './boardSession'

const NOW = 1_800_000_000_000
const CLIENT = 'boardclient'
const USER = 'dana@example.com'
const key = (name: string) => `CognitoIdentityServiceProvider.${CLIENT}.${USER}.${name}`
const LAST_USER = `CognitoIdentityServiceProvider.${CLIENT}.LastAuthUser`

/** An ID token expiring `inSeconds` after NOW. */
const idToken = (inSeconds: number, email = USER) => fakeJwt({ email, exp: NOW / 1000 + inSeconds })

function setup(call = vi.fn<(target: string, payload: object) => Promise<unknown>>()) {
  const items = new Map<string, string>()
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v) },
    removeItem: (k: string) => { items.delete(k) },
  }
  const session = createBoardSession({ clientId: CLIENT, storage, now: () => NOW, call })
  return { session, items, call }
}

const refreshAnswer = (fresh: string, rotated?: string) => ({
  AuthenticationResult: { IdToken: fresh, AccessToken: 'access-2', ...(rotated === undefined ? {} : { RefreshToken: rotated }) },
})

describe('the board session', () => {
  it('stores a sign-in under the amazon-cognito-identity-js keys', () => {
    const { session, items } = setup()

    session.save(USER, { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' })

    expect(Object.fromEntries(items)).toStrictEqual({
      [key('idToken')]: 'id', [key('accessToken')]: 'access', [key('refreshToken')]: 'refresh', [LAST_USER]: USER,
    })
  })

  it('reads a session stored by the former library (legacy keys, clockDrift included)', async () => {
    const { session, items, call } = setup()
    const token = idToken(3600)
    items.set(LAST_USER, USER).set(key('idToken'), token).set(key('refreshToken'), 'r').set(key('clockDrift'), '0')

    await expect(session.idToken()).resolves.toBe(token)
    await expect(session.email()).resolves.toBe(USER)
    expect(call).not.toHaveBeenCalled()

    session.clear()
    expect(items.size).toBe(0)
  })

  it('is signed out with nothing stored', async () => {
    const { session } = setup()
    await expect(session.idToken()).resolves.toBeNull()
    await expect(session.email()).resolves.toBeNull()
  })

  it('refreshes a nearly expired token with REFRESH_TOKEN_AUTH, keeping the refresh token', async () => {
    const { session, items, call } = setup()
    session.save(USER, { IdToken: idToken(10), AccessToken: 'a', RefreshToken: 'refresh-1' })
    const fresh = idToken(3600)
    call.mockResolvedValue(refreshAnswer(fresh))

    await expect(session.idToken()).resolves.toBe(fresh)

    expect(call).toHaveBeenCalledWith('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: CLIENT, AuthParameters: { REFRESH_TOKEN: 'refresh-1' },
    })
    expect([key('idToken'), key('accessToken'), key('refreshToken')].map((k) => items.get(k)))
      .toStrictEqual([fresh, 'access-2', 'refresh-1'])
  })

  it('stores a rotated refresh token', async () => {
    const { session, items, call } = setup()
    session.save(USER, { IdToken: idToken(-1), AccessToken: 'a', RefreshToken: 'refresh-1' })
    call.mockResolvedValue(refreshAnswer(idToken(3600), 'refresh-2'))

    await session.idToken()

    expect(items.get(key('refreshToken'))).toBe('refresh-2')
  })

  it('refreshes a valid token when forced', async () => {
    const { session, call } = setup()
    session.save(USER, { IdToken: idToken(3600), AccessToken: 'a', RefreshToken: 'r' })
    const fresh = idToken(7200)
    call.mockResolvedValue(refreshAnswer(fresh))

    await expect(session.idToken(true)).resolves.toBe(fresh)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('shares one refresh between concurrent readers', async () => {
    const { session, call } = setup()
    session.save(USER, { IdToken: idToken(-1), AccessToken: 'a', RefreshToken: 'r' })
    const fresh = idToken(3600)
    call.mockResolvedValue(refreshAnswer(fresh))

    await expect(Promise.all([session.idToken(), session.idToken(), session.email()]))
      .resolves.toStrictEqual([fresh, fresh, USER])
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('signs out when Cognito refuses the refresh token', async () => {
    const { session, items, call } = setup()
    session.save(USER, { IdToken: idToken(-1), AccessToken: 'a', RefreshToken: 'r' })
    call.mockRejectedValue(new CognitoRefusal({ __type: 'NotAuthorizedException', message: 'Refresh Token has expired' }))

    await expect(session.idToken()).resolves.toBeNull()
    expect(items.size).toBe(0)
  })

  it('keeps the session through a transient failure, for the next try', async () => {
    const { session, items, call } = setup()
    session.save(USER, { IdToken: idToken(-1), AccessToken: 'a', RefreshToken: 'r' })
    call.mockRejectedValueOnce(new CognitoRefusal({ __type: 'TooManyRequestsException' }))
    call.mockRejectedValueOnce(new Error('offline'))

    await expect(session.idToken()).resolves.toBeNull()
    await expect(session.idToken()).resolves.toBeNull()
    expect(items.get(key('refreshToken'))).toBe('r')

    const fresh = idToken(3600)
    call.mockResolvedValueOnce(refreshAnswer(fresh))
    await expect(session.idToken()).resolves.toBe(fresh)
  })

  it('answers null (keeping the session) for an unreadable refresh answer', async () => {
    const { session, items, call } = setup()
    session.save(USER, { IdToken: idToken(-1), AccessToken: 'a', RefreshToken: 'r' })
    call.mockResolvedValue({ ChallengeName: 'SOMETHING' })

    await expect(session.idToken()).resolves.toBeNull()
    expect(items.get(LAST_USER)).toBe(USER)
  })

  it('clears a stored user without a refresh token once the ID token expires', async () => {
    const { session, items, call } = setup()
    items.set(LAST_USER, USER).set(key('idToken'), idToken(-1))

    await expect(session.idToken()).resolves.toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(items.size).toBe(0)
  })

  it('replaces another user’s session on a new sign-in', () => {
    const { session, items } = setup()
    session.save('old@example.com', { IdToken: 'old', AccessToken: 'old', RefreshToken: 'old' })

    session.save(USER, { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' })

    expect([...items.keys()].some((k) => k.includes('old@example.com'))).toBe(false)
    expect(items.get(LAST_USER)).toBe(USER)
  })
})
