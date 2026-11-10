/**
 * @fileoverview The Cognito plumbing of the board pool's sign-in (services/boardAuth.ts): errors,
 * the random password nobody keeps, and the answer shapes. No state, no storage.
 *
 * @module services/boardCognito
 */
import { z } from 'zod'

/** Why a board sign-in step failed — each maps to `featureRequests:auth.errors.<code>`. */
export type BoardAuthErrorCode =
  | 'domain_not_allowed' | 'wrong_code' | 'expired' | 'too_many' | 'no_session' | 'invalid_email' | 'unknown'

export class BoardAuthError extends Error {
  readonly code: BoardAuthErrorCode

  constructor(code: BoardAuthErrorCode) {
    super(`Board sign-in failed: ${code}`)
    this.name = 'BoardAuthError'
    this.code = code
  }
}

/** Cognito's exception names → the reason shown. Anything unlisted is `unknown`. */
const COGNITO_ERRORS: Readonly<Record<string, BoardAuthErrorCode>> = {
  CodeMismatchException: 'wrong_code',
  ExpiredCodeException: 'expired',
  NotAuthorizedException: 'expired',
  TooManyRequestsException: 'too_many',
  LimitExceededException: 'too_many',
  TooManyFailedAttemptsException: 'too_many',
  InvalidParameterException: 'invalid_email',
}

const cognitoErrorSchema = z.object({ __type: z.string().catch(''), message: z.string().catch('') })

/** A Cognito error body's exception name and message; `__type` may carry a `namespace#` prefix. */
function cognitoErrorOf(body: unknown): { type: string; message: string } {
  const parsed = cognitoErrorSchema.safeParse(body)
  if (!parsed.success) return { type: '', message: '' }
  return { type: parsed.data.__type.split('#').at(-1) ?? '', message: parsed.data.message }
}

/** The reason a Cognito error body states. */
function boardAuthErrorFor(body: unknown): BoardAuthErrorCode {
  const { type, message } = cognitoErrorOf(body)
  if (type === 'UserLambdaValidationException') {
    return message.includes('domain_not_allowed') ? 'domain_not_allowed' : 'unknown'
  }
  return COGNITO_ERRORS[type] ?? 'unknown'
}

/** A non-OK Cognito answer, kept with its body until it is mapped. */
export class CognitoRefusal extends Error {
  readonly body: unknown
  readonly type: string

  constructor(body: unknown) {
    super('Cognito refused the request')
    this.name = 'CognitoRefusal'
    this.body = body
    this.type = cognitoErrorOf(body).type
  }
}

export function toBoardAuthError(error: unknown): BoardAuthError {
  if (error instanceof BoardAuthError) return error
  if (error instanceof CognitoRefusal) return new BoardAuthError(boardAuthErrorFor(error.body))
  return new BoardAuthError('unknown')
}

const PASSWORD_CLASSES = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  '!@#$%^&*()-_=+[]{}',
] as const
const PASSWORD_LENGTH = 32

/** A uniformly random index below `bound`, by rejection sampling (no modulo bias). */
function randomIndex(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound
  const word = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(word)
    const value = word[0] ?? 0
    if (value < limit) return value % bound
  }
}

/**
 * A 32-character password meeting Cognito's strictest policy: at least one upper-case letter,
 * lower-case letter, digit and symbol, in a random order. Nobody keeps it: the board signs in by code.
 */
export function randomBoardPassword(): string {
  const everything = PASSWORD_CLASSES.join('')
  const chars = [
    ...PASSWORD_CLASSES.map((set) => set.charAt(randomIndex(set.length))),
    ...Array.from({ length: PASSWORD_LENGTH - PASSWORD_CLASSES.length }, () => everything.charAt(randomIndex(everything.length))),
  ]
  // Shuffled by random sort keys, so the guaranteed four are not always the first four.
  const keys = crypto.getRandomValues(new Uint32Array(chars.length))
  return chars
    .map((char, index) => ({ char, key: keys[index] ?? 0 }))
    .sort((a, b) => a.key - b.key)
    .map(({ char }) => char)
    .join('')
}

const authResultSchema = z.object({
  AuthenticationResult: z.object({
    IdToken: z.string().min(1),
    AccessToken: z.string().min(1),
    RefreshToken: z.string().min(1),
  }),
})
export type AuthTokens = z.infer<typeof authResultSchema>['AuthenticationResult']

/** An InitiateAuth / RespondToAuthChallenge answer that is (or offers) a challenge. */
export const challengeSchema = z.object({
  ChallengeName: z.string().catch(''),
  Session: z.string().min(1),
  AvailableChallenges: z.array(z.string()).catch([]),
})
export type Challenge = z.infer<typeof challengeSchema>

/** A SignUp / ConfirmSignUp answer: the session that signs the new account in at once, when given. */
export const sessionAnswerSchema = z.object({ Session: z.string().min(1).optional().catch(undefined) }).catch({})

/** The tokens of an answer, or null when it is not a completed sign-in. */
export function tokensOf(body: unknown): AuthTokens | null {
  const parsed = authResultSchema.safeParse(body)
  return parsed.success ? parsed.data.AuthenticationResult : null
}

/** A REFRESH_TOKEN_AUTH answer: new ID and access tokens, and a new refresh token only when the pool rotates them. */
const refreshResultSchema = z.object({
  AuthenticationResult: z.object({
    IdToken: z.string().min(1),
    AccessToken: z.string().min(1),
    RefreshToken: z.string().min(1).optional().catch(undefined),
  }),
})

/** The tokens of a refresh answer (keeping `refreshToken` when Cognito sent no new one), or null. */
export function refreshedTokensOf(body: unknown, refreshToken: string): AuthTokens | null {
  const parsed = refreshResultSchema.safeParse(body)
  if (!parsed.success) return null
  const result = parsed.data.AuthenticationResult
  return { IdToken: result.IdToken, AccessToken: result.AccessToken, RefreshToken: result.RefreshToken ?? refreshToken }
}
