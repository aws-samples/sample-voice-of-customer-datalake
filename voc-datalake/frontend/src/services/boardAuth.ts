/**
 * @fileoverview Sign-in for the board pool (feedback boards and document review links;
 * docs/feature-requests.md -> Sign-in, docs/document-review.md).
 *
 * Every sign-in is an emailed code (also delivered as a link), with plain `fetch` calls to the
 * regional Cognito endpoint (no SDK). The signed-in session is kept and refreshed by
 * services/boardSession.ts. Which code depends on the person and the pool's
 * mode (`board.signIn` in config.json, lib/stacks/core-board-auth.ts):
 *
 * - **New person** (both modes): `SignUp` with a random password nobody keeps (`ClientMetadata`
 *   names the review link, which the PreSignUp trigger checks). Cognito emails a CONFIRMATION code;
 *   `ConfirmSignUp` proves the inbox, and its `Session` signs the account in at once (`USER_AUTH`).
 *   The pool never auto-confirms: owning the inbox is the only proof.
 * - **Returning person, `email_otp`** (SES): `InitiateAuth` `USER_AUTH` preferring `EMAIL_OTP`,
 *   then `RespondToAuthChallenge` with the code.
 * - **Returning person, `code`** (Cognito's own email, no SES): `ForgotPassword` emails a reset
 *   code; `ConfirmForgotPassword` sets a fresh random password this browser holds for one call
 *   and signs in with it (`USER_AUTH`, `PASSWORD`).
 * - An account that never confirmed gets `ResendConfirmationCode` (the new-person path).
 *
 * When a step cannot finish the sign-in by itself (no session after a confirmation), it starts the
 * returning-person step, which emails a second code: `verifyCode` then answers `next`.
 *
 * The pending sign-in lives in localStorage (`voc-board-otp`, 9 minutes) so the emailed link can
 * finish it in this browser; it carries the board or review page to return to, never a password.
 * Nothing here logs: tokens, codes and addresses never reach the console.
 *
 * @module services/boardAuth
 */
import { z } from 'zod'
import { isValidSlug } from '../api/boardFields'
import { looksLikeEmail } from '../utils/looksLikeEmail'
import {
  BoardAuthError, CognitoRefusal, challengeSchema, randomBoardPassword, sessionAnswerSchema, toBoardAuthError,
  tokensOf,
} from './boardCognito'
import type { AuthTokens, Challenge } from './boardCognito'
import { createBoardSession, type SessionStorage } from './boardSession'
import type { BoardPoolConfig } from '../runtimeConfig'
import { nullOnRejection } from '../lib/rejections'

/** The localStorage key of a sign-in waiting for its code. */
export const PENDING_OTP_KEY = 'voc-board-otp'

/** How long a pending sign-in is offered (Cognito's auth session is 10 minutes). */
const PENDING_TTL_MS = 9 * 60 * 1000

/** A review page a sign-in returns to (`/review/shr_…`, the link's own path). */
const REVIEW_PATH_RE = /^\/review\/shr_[0-9a-f]{32}$/
export const isReviewPath = (value: unknown): value is string => typeof value === 'string' && REVIEW_PATH_RE.test(value)

const pendingSchema = z.object({
  email: z.string().min(1),
  /** otp: the EMAIL_OTP challenge; confirm: a sign-up confirmation; reset: a password-reset code. */
  step: z.enum(['otp', 'confirm', 'reset']).catch('otp').default('otp'),
  /** The EMAIL_OTP session, or the sign-up session that signs in after confirmation ('' = none). */
  session: z.string().catch(''),
  expiresAt: z.number(),
  /** The board slug the visitor opened before signing in (never trusted unread: re-checked on read). */
  board: z.string().refine(isValidSlug).optional().catch(undefined),
  /** The review page the visitor opened (`/review/shr_…`). */
  returnTo: z.string().refine(isReviewPath).optional().catch(undefined),
})
export type PendingSignIn = z.infer<typeof pendingSchema>

/** Where a sign-in started: a board, or a review link. */
export interface SignInTarget {
  readonly board?: string
  readonly returnTo?: string
}

export type VerifyResult =
  | { readonly status: 'signed_in'; readonly email: string }
  | { readonly status: 'next'; readonly pending: PendingSignIn }

/** The address as Cognito stores it (email is the username). */
export function normalizeBoardEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface BoardAuthDeps {
  readonly pool: BoardPoolConfig
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Where the pending sign-in and the Cognito session live; defaults to localStorage. */
  readonly storage?: SessionStorage
  readonly now?: () => number
}

/** The target fields a pending sign-in keeps (only well-formed ones). */
function targetFields(target: SignInTarget): Pick<PendingSignIn, 'board' | 'returnTo'> {
  return {
    ...(target.board !== undefined && isValidSlug(target.board) ? { board: target.board } : {}),
    ...(isReviewPath(target.returnTo) ? { returnTo: target.returnTo } : {}),
  }
}

/** `ClientMetadata` for the PreSignUp trigger: the review link a new account is for. */
function signUpMetadata(target: SignInTarget): Record<string, string> {
  return isReviewPath(target.returnTo) ? { share_id: target.returnTo.split('/').at(-1) ?? '' } : {}
}

/** The board sign-in service for one pool. */
export function createBoardAuth(deps: BoardAuthDeps) {
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const storage = deps.storage ?? window.localStorage
  const now = deps.now ?? Date.now
  const mode = deps.pool.signIn ?? 'email_otp'
  const clientId = deps.pool.clientId
  const endpoint = `https://cognito-idp.${deps.pool.region}.amazonaws.com/`

  /** One Cognito call: the parsed body, or a thrown CognitoRefusal / BoardAuthError. */
  async function call(target: string, payload: object): Promise<unknown> {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify(payload),
    }).catch(() => {
      throw new BoardAuthError('unknown')
    })
    // A body that is not JSON reads as no body; the status still decides.
    const body: unknown = await response.json().catch(nullOnRejection)
    if (!response.ok) throw new CognitoRefusal(body)
    return body
  }

  const session = createBoardSession({ clientId, storage, now, call })

  /** The same call, every refusal mapped to the reason shown. */
  const cognito = (target: string, payload: object) =>
    call(target, payload).catch((error: unknown) => { throw toBoardAuthError(error) })

  function storedPending(): PendingSignIn | null {
    const raw = storage.getItem(PENDING_OTP_KEY)
    if (raw === null) return null
    try {
      const parsed = pendingSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  function readPending(): PendingSignIn | null {
    const stored = storedPending()
    if (stored !== null && stored.expiresAt > now()) return stored
    storage.removeItem(PENDING_OTP_KEY)
    return null
  }

  function keep(pending: Omit<PendingSignIn, 'expiresAt'>): PendingSignIn {
    const entry = { ...pending, expiresAt: now() + PENDING_TTL_MS }
    storage.setItem(PENDING_OTP_KEY, JSON.stringify(entry))
    return entry
  }

  function keepSession(email: string, tokens: AuthTokens): string {
    session.save(email, tokens)
    storage.removeItem(PENDING_OTP_KEY)
    return email
  }

  function challengeOf(body: unknown): Challenge {
    const parsed = challengeSchema.safeParse(body)
    if (!parsed.success) throw new BoardAuthError('unknown')
    return parsed.data
  }

  /** `created` (Cognito emailed a confirmation code; its session, when given) or `exists`. */
  async function signUp(email: string, target: SignInTarget): Promise<{ created: boolean; session: string }> {
    try {
      const body = await call('SignUp', {
        ClientId: clientId, Username: email, Password: randomBoardPassword(),
        UserAttributes: [{ Name: 'email', Value: email }], ClientMetadata: signUpMetadata(target),
      })
      return { created: true, session: sessionAnswerSchema.parse(body).Session ?? '' }
    } catch (error) {
      if (error instanceof CognitoRefusal && error.type === 'UsernameExistsException') return { created: false, session: '' }
      throw toBoardAuthError(error)
    }
  }

  /** EMAIL_OTP: the challenge session, choosing EMAIL_OTP when Cognito offers a choice. */
  async function emailOtpSession(email: string): Promise<string> {
    const first = challengeOf(await call('InitiateAuth', {
      AuthFlow: 'USER_AUTH', ClientId: clientId, AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
    }))
    const challenge = first.ChallengeName === 'SELECT_CHALLENGE' && first.AvailableChallenges.includes('EMAIL_OTP')
      ? challengeOf(await cognito('RespondToAuthChallenge', {
        ChallengeName: 'SELECT_CHALLENGE', ClientId: clientId, Session: first.Session,
        ChallengeResponses: { USERNAME: email, ANSWER: 'EMAIL_OTP' },
      }))
      : first
    // Any other challenge (a password, or no EMAIL_OTP on offer) means no code was sent.
    if (challenge.ChallengeName !== 'EMAIL_OTP') throw new BoardAuthError('unknown')
    return challenge.Session
  }

  /**
   * A known address: the returning person's code (EMAIL_OTP with SES, which also confirms an
   * account that never confirmed; else a password-reset code). An unconfirmed account refuses the
   * reset, and gets its confirmation code again instead (the new-person path).
   */
  async function returningStep(email: string, target: SignInTarget): Promise<PendingSignIn> {
    try {
      if (mode === 'email_otp') return keep({ email, step: 'otp', session: await emailOtpSession(email), ...targetFields(target) })
      await call('ForgotPassword', { ClientId: clientId, Username: email })
      return keep({ email, step: 'reset', session: '', ...targetFields(target) })
    } catch (error) {
      const unconfirmed = error instanceof CognitoRefusal
        && ['UserNotConfirmedException', 'InvalidParameterException'].includes(error.type)
      if (mode === 'email_otp' || !unconfirmed) throw toBoardAuthError(error)
    }
    await cognito('ResendConfirmationCode', { ClientId: clientId, Username: email, ClientMetadata: signUpMetadata(target) })
    return keep({ email, step: 'confirm', session: '', ...targetFields(target) })
  }

  /** Tokens from a USER_AUTH answer, answering a PASSWORD choice when Cognito asks for one. */
  async function passwordTokens(email: string, password: string): Promise<AuthTokens> {
    const body = await cognito('InitiateAuth', {
      AuthFlow: 'USER_AUTH', ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password, PREFERRED_CHALLENGE: 'PASSWORD' },
    })
    const direct = tokensOf(body)
    if (direct !== null) return direct
    const answer = await cognito('RespondToAuthChallenge', {
      ChallengeName: 'SELECT_CHALLENGE', ClientId: clientId, Session: challengeOf(body).Session,
      ChallengeResponses: { USERNAME: email, ANSWER: 'PASSWORD', PASSWORD: password },
    })
    const tokens = tokensOf(answer)
    if (tokens === null) throw new BoardAuthError('unknown')
    return tokens
  }

  async function finishOtp(pending: PendingSignIn, code: string): Promise<VerifyResult> {
    const tokens = tokensOf(await cognito('RespondToAuthChallenge', {
      ChallengeName: 'EMAIL_OTP', ClientId: clientId, Session: pending.session,
      ChallengeResponses: { USERNAME: pending.email, EMAIL_OTP_CODE: code },
    }))
    if (tokens === null) throw new BoardAuthError('unknown')
    return { status: 'signed_in', email: keepSession(pending.email, tokens) }
  }

  async function finishConfirm(pending: PendingSignIn, code: string): Promise<VerifyResult> {
    const confirmed = await cognito('ConfirmSignUp', {
      ClientId: clientId, Username: pending.email, ConfirmationCode: code,
      ...(pending.session === '' ? {} : { Session: pending.session }),
    })
    const session = sessionAnswerSchema.parse(confirmed).Session
    const tokens = session === undefined ? null : tokensOf(await cognito('InitiateAuth', {
      AuthFlow: 'USER_AUTH', ClientId: clientId, AuthParameters: { USERNAME: pending.email }, Session: session,
    }).catch(nullOnRejection))
    if (tokens !== null) return { status: 'signed_in', email: keepSession(pending.email, tokens) }
    // Confirmed but not signed in: the returning-person code finishes it.
    return { status: 'next', pending: await returningStep(pending.email, pending) }
  }

  async function finishReset(pending: PendingSignIn, code: string): Promise<VerifyResult> {
    const password = randomBoardPassword()
    await cognito('ConfirmForgotPassword', { ClientId: clientId, Username: pending.email, ConfirmationCode: code, Password: password })
    return { status: 'signed_in', email: keepSession(pending.email, await passwordTokens(pending.email, password)) }
  }

  const FINISH = { otp: finishOtp, confirm: finishConfirm, reset: finishReset } as const

  return {
    /** The sign-in mode of this pool (the login page words its hint by it). */
    mode,

    /** Email a code (and link). Resolves with the pending sign-in once Cognito has sent it. */
    async requestCode(rawEmail: string, target: SignInTarget = {}): Promise<PendingSignIn> {
      const email = normalizeBoardEmail(rawEmail)
      if (!looksLikeEmail(email)) throw new BoardAuthError('invalid_email')
      const account = await signUp(email, target)
      if (account.created) return keep({ email, step: 'confirm', session: account.session, ...targetFields(target) })
      return returningStep(email, target)
    },

    /** The sign-in waiting for its code in THIS browser, or null (none, or expired). */
    pending: readPending,

    /** Whether THIS browser asked for a code for `rawEmail` whose sign-in has since expired. */
    pendingExpiredFor(rawEmail: string): boolean {
      const stored = storedPending()
      return stored !== null && stored.expiresAt <= now() && stored.email === normalizeBoardEmail(rawEmail)
    },

    /**
     * Finish with the code. `rawEmail` (from the emailed link) must match the pending sign-in; a
     * link opened in another browser has no pending session there (`no_session`). `next` = a
     * second code was emailed (a confirmed account that still had to sign in).
     */
    async verifyCode(code: string, rawEmail?: string): Promise<VerifyResult> {
      const pending = readPending()
      const email = rawEmail === undefined ? pending?.email : normalizeBoardEmail(rawEmail)
      if (!pending || pending.email !== email) throw new BoardAuthError('no_session')
      try {
        return await FINISH[pending.step](pending, code.trim())
      } catch (error) {
        const reason = toBoardAuthError(error)
        // A wrong code may be retried on the same pending sign-in; anything else ends it.
        if (reason.code !== 'wrong_code') storage.removeItem(PENDING_OTP_KEY)
        throw reason
      }
    },

    /** Forget the pending sign-in (the "use another email" action). */
    cancelPending(): void {
      storage.removeItem(PENDING_OTP_KEY)
    },

    /** The signed-in board user's ID token, refreshed when expired (or when forced); null when signed out. */
    getIdToken(forceRefresh = false): Promise<string | null> {
      return session.idToken(forceRefresh)
    },

    /** The signed-in board user's email, or null. */
    currentEmail(): Promise<string | null> {
      return session.email()
    },

    /** Forget the board session in this browser. */
    signOut(): void {
      session.clear()
      storage.removeItem(PENDING_OTP_KEY)
    },
  }
}

export type BoardAuth = ReturnType<typeof createBoardAuth>
