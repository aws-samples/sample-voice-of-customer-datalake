/**
 * The board sign-in flow against a scripted Cognito (an injected fetch) and an in-memory storage:
 * a new person confirms the sign-up code (the pool never auto-confirms), a returning person gets an
 * EMAIL_OTP code (SES pools) or a password-reset code (`code` pools, Cognito's own email).
 */
import { describe, it, expect, vi } from 'vitest'
import { PENDING_OTP_KEY, createBoardAuth } from './boardAuth'
import { BoardAuthError } from './boardCognito'
import type { BoardPoolConfig } from '../runtimeConfig'

const OTP_POOL: BoardPoolConfig = { userPoolId: 'us-east-1_board', clientId: 'boardclient', region: 'us-east-1', signIn: 'email_otp' }
const CODE_POOL: BoardPoolConfig = { ...OTP_POOL, signIn: 'code' }
const NOW = 1_800_000_000_000
const SHARE_ID = `shr_${'a'.repeat(32)}`
const REVIEW_PATH = `/review/${SHARE_ID}`

/** An unsigned JWT the library can decode; `exp` an hour after NOW. */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')
  return `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000), ...claims })}.sig`
}

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    setItem: (key: string, value: string) => { items.set(key, value) },
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => { items.delete(key) },
    clear: () => { items.clear() },
  }
}

interface Answer { readonly status: number; readonly body: unknown }
type Script = Partial<Record<string, Answer | Answer[]>>

const NEW_ACCOUNT: Answer = { status: 200, body: { UserConfirmed: false, Session: 'signup-session' } }
const NEW_ACCOUNT_NO_SESSION: Answer = { status: 200, body: { UserConfirmed: false } }
const OTP_CHALLENGE: Answer = { status: 200, body: { ChallengeName: 'EMAIL_OTP', Session: 'otp-session-1' } }
const TOKENS: Answer = {
  status: 200,
  body: {
    AuthenticationResult: {
      IdToken: fakeJwt({ email: 'dana@example.com', token_use: 'id' }),
      AccessToken: fakeJwt({ token_use: 'access' }),
      RefreshToken: 'refresh-token',
    },
  },
}
const CONFIRMED_WITH_SESSION: Answer = { status: 200, body: { Session: 'confirm-session' } }
const EMPTY_OK: Answer = { status: 200, body: {} }

function refusal(type: string, message = ''): Answer {
  return { status: 400, body: { __type: type, message } }
}

function payloadOf(init: RequestInit | undefined): Record<string, unknown> {
  const payload: unknown = JSON.parse(String(init?.body))
  return typeof payload === 'object' && payload !== null ? Object.fromEntries(Object.entries(payload)) : {}
}

/** The scripted answer for one call; an unscripted target answers 500. */
function nextAnswer(entry: Answer | Answer[] | undefined): Answer {
  const answer = Array.isArray(entry) ? entry.shift() : entry
  return answer ?? { status: 500, body: {} }
}

/** A Cognito double answering each target from `script` (an array answers one per call). */
function scriptedCognito(script: Script) {
  const calls: Array<{ target: string; payload: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const target = (new Headers(init?.headers).get('X-Amz-Target') ?? '').replace('AWSCognitoIdentityProviderService.', '')
    calls.push({ target, payload: payloadOf(init) })
    const answer = nextAnswer(script[target])
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }))
  })
  return { calls, fetchImpl }
}

function setup(script: Script, pool: BoardPoolConfig = OTP_POOL) {
  const storage = memoryStorage()
  const cognito = scriptedCognito(script)
  const auth = createBoardAuth({ pool, fetchImpl: cognito.fetchImpl, storage, now: () => NOW })
  return { auth, storage, ...cognito }
}

const targetsOf = (calls: ReadonlyArray<{ target: string }>) => calls.map((call) => call.target)

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    return error instanceof BoardAuthError ? error.code : 'not-a-board-error'
  }
  return 'resolved'
}

describe('a new person', () => {
  it('signs up and waits for the confirmation code, without signing in yet', async () => {
    const { auth, calls, storage } = setup({ SignUp: NEW_ACCOUNT })

    const pending = await auth.requestCode('  Dana@Example.com ')

    expect(targetsOf(calls)).toStrictEqual(['SignUp'])
    expect(calls[0]?.payload).toMatchObject({
      ClientId: 'boardclient', Username: 'dana@example.com',
      UserAttributes: [{ Name: 'email', Value: 'dana@example.com' }], ClientMetadata: {},
    })
    expect(pending).toStrictEqual({ email: 'dana@example.com', step: 'confirm', session: 'signup-session', expiresAt: NOW + 9 * 60 * 1000 })
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(true)
  })

  it('confirms the code and signs in at once with the confirmation session', async () => {
    const { auth, calls, storage } = setup({ SignUp: NEW_ACCOUNT, ConfirmSignUp: CONFIRMED_WITH_SESSION, InitiateAuth: TOKENS })
    await auth.requestCode('dana@example.com')

    await expect(auth.verifyCode(' 123456 ')).resolves.toStrictEqual({ status: 'signed_in', email: 'dana@example.com' })

    expect(calls.slice(1)).toStrictEqual([
      { target: 'ConfirmSignUp', payload: { ClientId: 'boardclient', Username: 'dana@example.com', ConfirmationCode: '123456', Session: 'signup-session' } },
      { target: 'InitiateAuth', payload: { AuthFlow: 'USER_AUTH', ClientId: 'boardclient', AuthParameters: { USERNAME: 'dana@example.com' }, Session: 'confirm-session' } },
    ])
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(false)
    expect(storage.items.get('CognitoIdentityServiceProvider.boardclient.dana@example.com.refreshToken')).toBe('refresh-token')
  })

  it('omits the session from ConfirmSignUp when the sign-up gave none', async () => {
    const { auth, calls } = setup({ SignUp: NEW_ACCOUNT_NO_SESSION, ConfirmSignUp: CONFIRMED_WITH_SESSION, InitiateAuth: TOKENS })
    await auth.requestCode('dana@example.com')
    await auth.verifyCode('123456')

    expect(calls[1]?.payload).not.toHaveProperty('Session')
  })

  it('emails a second (EMAIL_OTP) code when the confirmation cannot sign in by itself', async () => {
    const { auth, calls } = setup({
      SignUp: NEW_ACCOUNT, ConfirmSignUp: EMPTY_OK, InitiateAuth: OTP_CHALLENGE, RespondToAuthChallenge: TOKENS,
    })
    await auth.requestCode('dana@example.com')

    const first = await auth.verifyCode('123456')

    expect(first).toStrictEqual({ status: 'next', pending: { email: 'dana@example.com', step: 'otp', session: 'otp-session-1', expiresAt: NOW + 9 * 60 * 1000 } })
    await expect(auth.verifyCode('87654321')).resolves.toStrictEqual({ status: 'signed_in', email: 'dana@example.com' })
    expect(targetsOf(calls)).toStrictEqual(['SignUp', 'ConfirmSignUp', 'InitiateAuth', 'RespondToAuthChallenge'])
  })

  it('falls back to the second code when signing in with the confirmation session is refused', async () => {
    const { auth } = setup({
      SignUp: NEW_ACCOUNT, ConfirmSignUp: CONFIRMED_WITH_SESSION,
      InitiateAuth: [refusal('NotAuthorizedException'), OTP_CHALLENGE],
    })
    await auth.requestCode('dana@example.com')

    await expect(auth.verifyCode('123456')).resolves.toMatchObject({ status: 'next', pending: { step: 'otp' } })
  })

  it('keeps the pending confirmation after a wrong code so the person can retry', async () => {
    const { auth, storage } = setup({
      SignUp: NEW_ACCOUNT, ConfirmSignUp: [refusal('CodeMismatchException'), CONFIRMED_WITH_SESSION], InitiateAuth: TOKENS,
    })
    await auth.requestCode('dana@example.com')

    await expect(failureOf(auth.verifyCode('000000'))).resolves.toBe('wrong_code')
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(true)
    await expect(auth.verifyCode('123456')).resolves.toMatchObject({ status: 'signed_in' })
  })

  it('names the review link in ClientMetadata for the PreSignUp check and keeps the page to return to', async () => {
    const { auth, calls } = setup({ SignUp: NEW_ACCOUNT })

    await auth.requestCode('dana@example.com', { returnTo: REVIEW_PATH })

    expect(calls[0]?.payload['ClientMetadata']).toStrictEqual({ share_id: SHARE_ID })
    expect(auth.pending()).toMatchObject({ returnTo: REVIEW_PATH })
  })

  it('drops a return path that is not a review link', async () => {
    const { auth, calls } = setup({ SignUp: NEW_ACCOUNT })

    await auth.requestCode('dana@example.com', { returnTo: 'https://evil.example/review/x' })

    expect(calls[0]?.payload['ClientMetadata']).toStrictEqual({})
    expect(auth.pending()).not.toHaveProperty('returnTo')
  })
})

describe('a returning person on an SES pool (email_otp)', () => {
  function returningOtp() {
    return setup({ SignUp: refusal('UsernameExistsException'), InitiateAuth: OTP_CHALLENGE, RespondToAuthChallenge: TOKENS })
  }

  it('starts an EMAIL_OTP sign-in for a known address', async () => {
    const { auth, calls } = returningOtp()

    await expect(auth.requestCode('dana@example.com')).resolves.toMatchObject({ step: 'otp', session: 'otp-session-1' })
    expect(calls[1]).toMatchObject({ target: 'InitiateAuth', payload: { AuthFlow: 'USER_AUTH', AuthParameters: { USERNAME: 'dana@example.com', PREFERRED_CHALLENGE: 'EMAIL_OTP' } } })
  })

  it('finishes with the EMAIL_OTP code and clears the pending sign-in', async () => {
    const { auth, calls, storage } = returningOtp()
    await auth.requestCode('dana@example.com')

    await expect(auth.verifyCode(' 12345678 ')).resolves.toStrictEqual({ status: 'signed_in', email: 'dana@example.com' })
    expect(calls[2]?.payload).toMatchObject({
      ChallengeName: 'EMAIL_OTP', Session: 'otp-session-1',
      ChallengeResponses: { USERNAME: 'dana@example.com', EMAIL_OTP_CODE: '12345678' },
    })
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(false)
  })

  it('keeps the session in the board pool cache so it can be refreshed', async () => {
    const { auth } = returningOtp()
    await auth.requestCode('dana@example.com')
    await auth.verifyCode('12345678')

    await expect(auth.currentEmail()).resolves.toBe('dana@example.com')
    await expect(auth.getIdToken()).resolves.toMatch(/\.sig$/)
  })

  it('picks EMAIL_OTP when Cognito answers SELECT_CHALLENGE', async () => {
    const { auth, calls } = setup({
      SignUp: refusal('UsernameExistsException'),
      InitiateAuth: { status: 200, body: { ChallengeName: 'SELECT_CHALLENGE', Session: 'select-1', AvailableChallenges: ['PASSWORD', 'EMAIL_OTP'] } },
      RespondToAuthChallenge: OTP_CHALLENGE,
    })
    await auth.requestCode('dana@example.com')

    expect(calls.at(-1)).toStrictEqual({ target: 'RespondToAuthChallenge', payload: {
      ChallengeName: 'SELECT_CHALLENGE', ClientId: 'boardclient', Session: 'select-1',
      ChallengeResponses: { USERNAME: 'dana@example.com', ANSWER: 'EMAIL_OTP' },
    } })
    expect(auth.pending()).toMatchObject({ session: 'otp-session-1' })
  })

  it('refuses a sign-in that offers no emailed code, keeping nothing', async () => {
    const { auth, storage } = setup({
      SignUp: refusal('UsernameExistsException'),
      InitiateAuth: { status: 200, body: { ChallengeName: 'SELECT_CHALLENGE', Session: 'select-1', AvailableChallenges: ['PASSWORD'] } },
    })
    await expect(failureOf(auth.requestCode('dana@example.com'))).resolves.toBe('unknown')
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(false)
  })

  it('does not fall back to a confirmation resend (EMAIL_OTP confirms by itself)', async () => {
    const { auth, calls } = setup({ SignUp: refusal('UsernameExistsException'), InitiateAuth: refusal('UserNotConfirmedException') })

    await expect(failureOf(auth.requestCode('dana@example.com'))).resolves.toBe('unknown')
    expect(targetsOf(calls)).toStrictEqual(['SignUp', 'InitiateAuth'])
  })

  it('ends an expired sign-in session and asks for a new code', async () => {
    const { auth, storage } = setup({
      SignUp: refusal('UsernameExistsException'), InitiateAuth: OTP_CHALLENGE,
      RespondToAuthChallenge: refusal('NotAuthorizedException', 'Invalid session for the user, session is expired.'),
    })
    await auth.requestCode('dana@example.com')

    await expect(failureOf(auth.verifyCode('12345678'))).resolves.toBe('expired')
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(false)
  })

  it('reports throttling as too many attempts', async () => {
    const { auth } = setup({ SignUp: refusal('UsernameExistsException'), InitiateAuth: refusal('TooManyRequestsException') })
    await expect(failureOf(auth.requestCode('dana@example.com'))).resolves.toBe('too_many')
  })
})

describe('a returning person on a Cognito-email pool (code)', () => {
  it('emails a password-reset code, then sets a fresh random password and signs in with it', async () => {
    const { auth, calls } = setup({
      SignUp: refusal('UsernameExistsException'), ForgotPassword: EMPTY_OK, ConfirmForgotPassword: EMPTY_OK, InitiateAuth: TOKENS,
    }, CODE_POOL)

    await expect(auth.requestCode('dana@example.com')).resolves.toMatchObject({ step: 'reset', session: '' })
    await expect(auth.verifyCode('123456')).resolves.toStrictEqual({ status: 'signed_in', email: 'dana@example.com' })

    const password = calls[2]?.payload['Password']
    expect(String(password)).toHaveLength(32)
    expect(calls).toMatchObject([
      { target: 'SignUp' },
      { target: 'ForgotPassword', payload: { Username: 'dana@example.com' } },
      { target: 'ConfirmForgotPassword', payload: { Username: 'dana@example.com', ConfirmationCode: '123456' } },
      { target: 'InitiateAuth', payload: { AuthFlow: 'USER_AUTH', AuthParameters: { USERNAME: 'dana@example.com', PASSWORD: password, PREFERRED_CHALLENGE: 'PASSWORD' } } },
    ])
  })

  it('answers a PASSWORD choice when Cognito offers SELECT_CHALLENGE', async () => {
    const { auth, calls } = setup({
      SignUp: refusal('UsernameExistsException'), ForgotPassword: EMPTY_OK, ConfirmForgotPassword: EMPTY_OK,
      InitiateAuth: { status: 200, body: { ChallengeName: 'SELECT_CHALLENGE', Session: 'select-2', AvailableChallenges: ['PASSWORD'] } },
      RespondToAuthChallenge: TOKENS,
    }, CODE_POOL)
    await auth.requestCode('dana@example.com')

    await expect(auth.verifyCode('123456')).resolves.toMatchObject({ status: 'signed_in' })
    expect(calls.at(-1)?.payload).toMatchObject({
      ChallengeName: 'SELECT_CHALLENGE', Session: 'select-2',
      ChallengeResponses: { USERNAME: 'dana@example.com', ANSWER: 'PASSWORD', PASSWORD: calls[2]?.payload['Password'] },
    })
  })

  it('resends the confirmation code to an account that never confirmed', async () => {
    const { auth, calls } = setup({
      SignUp: refusal('UsernameExistsException'), ForgotPassword: refusal('InvalidParameterException'), ResendConfirmationCode: EMPTY_OK,
    }, CODE_POOL)

    await expect(auth.requestCode('dana@example.com', { returnTo: REVIEW_PATH })).resolves.toMatchObject({ step: 'confirm', session: '', returnTo: REVIEW_PATH })
    expect(calls.at(-1)).toStrictEqual({ target: 'ResendConfirmationCode', payload: {
      ClientId: 'boardclient', Username: 'dana@example.com', ClientMetadata: { share_id: SHARE_ID },
    } })
  })

  it('reports a refused reset that is not about confirmation as is', async () => {
    const { auth, calls } = setup({ SignUp: refusal('UsernameExistsException'), ForgotPassword: refusal('LimitExceededException') }, CODE_POOL)

    await expect(failureOf(auth.requestCode('dana@example.com'))).resolves.toBe('too_many')
    expect(targetsOf(calls)).not.toContain('ResendConfirmationCode')
  })

  it('emails a password-reset code as the second code when a confirmation cannot sign in', async () => {
    const { auth } = setup({ SignUp: NEW_ACCOUNT, ConfirmSignUp: EMPTY_OK, ForgotPassword: EMPTY_OK }, CODE_POOL)
    await auth.requestCode('dana@example.com')

    await expect(auth.verifyCode('123456')).resolves.toMatchObject({ status: 'next', pending: { step: 'reset' } })
  })
})

describe('the pending sign-in', () => {
  it('keeps the board the visitor opened, and only a well-formed slug', async () => {
    const kept = setup({ SignUp: NEW_ACCOUNT })
    await kept.auth.requestCode('dana@example.com', { board: 'beta-board' })
    expect(kept.auth.pending()).toMatchObject({ email: 'dana@example.com', board: 'beta-board' })

    const refused = setup({ SignUp: NEW_ACCOUNT })
    await refused.auth.requestCode('dana@example.com', { board: '../admin' })
    expect(refused.auth.pending()).not.toHaveProperty('board')
  })

  it('reads a tampered board or return path as none, and a stored entry without a step as EMAIL_OTP', () => {
    const { auth, storage } = setup({})
    storage.setItem(PENDING_OTP_KEY, JSON.stringify({
      email: 'dana@example.com', session: 's', expiresAt: NOW + 1000, board: 'https://evil.example', returnTo: '/admin',
    }))
    expect(auth.pending()).toStrictEqual({
      email: 'dana@example.com', step: 'otp', session: 's', expiresAt: NOW + 1000, board: undefined, returnTo: undefined,
    })
  })

  it('tells an expired sign-in of this browser apart from none (before pending() forgets it)', async () => {
    const storage = memoryStorage()
    const clock = { now: NOW }
    const cognito = scriptedCognito({ SignUp: NEW_ACCOUNT })
    const auth = createBoardAuth({ pool: OTP_POOL, fetchImpl: cognito.fetchImpl, storage, now: () => clock.now })
    await auth.requestCode('dana@example.com')
    expect(auth.pendingExpiredFor('dana@example.com')).toBe(false)
    clock.now += 10 * 60 * 1000
    expect(auth.pendingExpiredFor('Dana@Example.com')).toBe(true)
    expect(auth.pending()).toBeNull()
    expect([auth.pendingExpiredFor('kim@example.com'), auth.pendingExpiredFor('dana@example.com')]).toStrictEqual([false, false])
  })

  it('forgets a pending sign-in once its 9 minutes are over', () => {
    const storage = memoryStorage()
    storage.setItem(PENDING_OTP_KEY, JSON.stringify({ email: 'dana@example.com', step: 'otp', session: 's', expiresAt: NOW - 1 }))
    const auth = createBoardAuth({ pool: OTP_POOL, fetchImpl: vi.fn(), storage, now: () => NOW })

    expect(auth.pending()).toBeNull()
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(false)
  })

  it('reports no session when the emailed link is opened in another browser', async () => {
    const { auth, calls } = setup({})
    await expect(failureOf(auth.verifyCode('12345678', 'dana@example.com'))).resolves.toBe('no_session')
    expect(calls).toHaveLength(0)
  })

  it('reports no session for a link meant for a different email than the pending one', async () => {
    const { auth } = setup({ SignUp: NEW_ACCOUNT })
    await auth.requestCode('dana@example.com')
    await expect(failureOf(auth.verifyCode('12345678', 'lee@example.com'))).resolves.toBe('no_session')
  })

  it('forgets the pending sign-in on "use another email"', async () => {
    const { auth, storage } = setup({ SignUp: NEW_ACCOUNT })
    await auth.requestCode('dana@example.com')
    auth.cancelPending()
    expect(storage.items.has(PENDING_OTP_KEY)).toBe(false)
  })
})

describe('board sign-in refusals and sign-out', () => {
  it('refuses an email whose domain is not allowed, before any code is sent', async () => {
    const { auth, calls } = setup({
      SignUp: refusal('UserLambdaValidationException', 'PreSignUp failed with error domain_not_allowed.'),
    })
    await expect(failureOf(auth.requestCode('pat@elsewhere.example'))).resolves.toBe('domain_not_allowed')
    expect(calls).toHaveLength(1)
  })

  it('refuses a malformed email without calling Cognito', async () => {
    const { auth, calls } = setup({})
    await expect(failureOf(auth.requestCode('not an email'))).resolves.toBe('invalid_email')
    expect(calls).toHaveLength(0)
  })

  it('reports a network failure as an unknown error', async () => {
    const auth = createBoardAuth({ pool: OTP_POOL, fetchImpl: vi.fn().mockRejectedValue(new TypeError('offline')), storage: memoryStorage(), now: () => NOW })
    await expect(failureOf(auth.requestCode('dana@example.com'))).resolves.toBe('unknown')
  })

  it('signs out by forgetting the cached session', async () => {
    const { auth } = setup({ SignUp: NEW_ACCOUNT, ConfirmSignUp: CONFIRMED_WITH_SESSION, InitiateAuth: TOKENS })
    await auth.requestCode('dana@example.com')
    await auth.verifyCode('123456')

    auth.signOut()

    await expect(auth.currentEmail()).resolves.toBeNull()
    await expect(auth.getIdToken()).resolves.toBeNull()
  })

  it('exposes the pool mode, EMAIL_OTP when the config does not say', () => {
    const legacy: BoardPoolConfig = { userPoolId: OTP_POOL.userPoolId, clientId: OTP_POOL.clientId, region: OTP_POOL.region }
    expect([
      createBoardAuth({ pool: legacy, storage: memoryStorage() }).mode,
      createBoardAuth({ pool: CODE_POOL, storage: memoryStorage() }).mode,
    ]).toStrictEqual(['email_otp', 'code'])
  })
})
