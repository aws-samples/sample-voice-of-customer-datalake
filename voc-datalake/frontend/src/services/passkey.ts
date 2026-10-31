/**
 * @fileoverview Opt-in passkeys for the app user pool (docs/deployment.md -> Passkeys).
 *
 * - **Register** (signed in): `StartWebAuthnRegistration` with the access token answers WebAuthn
 *   creation options; the browser makes the credential (`navigator.credentials.create`) and
 *   `CompleteWebAuthnRegistration` stores its public key in Cognito.
 * - **Sign in**: `InitiateAuth` with the choice-based `USER_AUTH` flow preferring `WEB_AUTHN` answers
 *   request options; the browser signs the challenge (`navigator.credentials.get`) and
 *   `RespondToAuthChallenge` returns the tokens.
 *
 * The WebAuthn JSON forms are converted by the browser's own `PublicKeyCredential.parse*FromJSON` and
 * `toJSON` (no base64url code here); a browser without them is treated as having no passkey support.
 *
 * @module services/passkey
 */
import { z } from 'zod'
import { CognitoRefusal, tokensOf } from './boardCognito'
import type { AuthTokens } from './boardCognito'
import { createCognitoIdpClient } from './cognitoIdp'
import type { FetchImpl } from './cognitoIdp'

/** Why a passkey step failed — each maps to `login:passkey.errors.<code>`. */
export type PasskeyErrorCode = 'cancelled' | 'no_passkey' | 'unsupported' | 'unknown'

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode

  constructor(code: PasskeyErrorCode) {
    super(`Passkey step failed: ${code}`)
    this.name = 'PasskeyError'
    this.code = code
  }
}

/** The WebAuthn JSON helpers this module relies on (newer browsers only). */
function hasJsonHelpers(): boolean {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential !== 'function') return false
  const statics: Partial<typeof PublicKeyCredential> = window.PublicKeyCredential
  return typeof statics.parseCreationOptionsFromJSON === 'function'
    && typeof statics.parseRequestOptionsFromJSON === 'function'
}

/** The part of `navigator.credentials` used here; answers are checked, so they are `unknown`. */
export interface PasskeyCredentials {
  create(options: CredentialCreationOptions): Promise<unknown>
  get(options: CredentialRequestOptions): Promise<unknown>
}

/** The browser's credentials container, when it has one. */
function browserCredentials(): PasskeyCredentials | undefined {
  return typeof navigator !== 'undefined' && 'credentials' in navigator ? navigator.credentials : undefined
}

/** Whether this browser can create and use passkeys with the WebAuthn JSON helpers. */
export function passkeySupported(): boolean {
  return hasJsonHelpers() && browserCredentials() !== undefined
}

// ---- Cognito answers ----------------------------------------------------------------------------------

const descriptorSchema = z.object({
  id: z.string().min(1),
  type: z.literal('public-key'),
}).loose()

const creationOptionsSchema = z.object({
  challenge: z.string().min(1),
  rp: z.object({ id: z.string().optional(), name: z.string() }).loose(),
  user: z.object({ id: z.string().min(1), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ alg: z.number(), type: z.literal('public-key') })),
  excludeCredentials: z.array(descriptorSchema).optional(),
}).loose()

const requestOptionsSchema = z.object({
  challenge: z.string().min(1),
  rpId: z.string().optional(),
  allowCredentials: z.array(descriptorSchema).optional(),
}).loose()

const startRegistrationSchema = z.object({ CredentialCreationOptions: creationOptionsSchema })

const listCredentialsSchema = z.object({ Credentials: z.array(z.object({ CredentialId: z.string() }).loose()) })

const webAuthnChallengeSchema = z.object({
  ChallengeName: z.literal('WEB_AUTHN'),
  Session: z.string().min(1),
  ChallengeParameters: z.object({ CREDENTIAL_REQUEST_OPTIONS: z.string().min(1), USERNAME: z.string().optional() }),
})

/** Whether a WebAuthn rejection is a NotAllowedError (checked by name: a DOMException may come from another realm). */
function isNotAllowed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotAllowedError'
}

/** The browser's credential, or a PasskeyError: a dismissed prompt or a timeout is `cancelled`. */
async function browserCredential(make: () => Promise<unknown>): Promise<PublicKeyCredential> {
  const credential = await make().catch((error: unknown) => {
    // NotAllowedError = the person closed the prompt, or it timed out (WebAuthn does not say which).
    throw new PasskeyError(isNotAllowed(error) ? 'cancelled' : 'unknown')
  })
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError('unknown')
  return credential
}

/** The credential's WebAuthn JSON form (the DOM types it as `any`). */
function credentialJson(credential: PublicKeyCredential): unknown {
  const json: unknown = credential.toJSON()
  return json
}

/** The request options inside a WEB_AUTHN challenge (a JSON string), or a PasskeyError. */
function requestOptionsOf(json: string): PublicKeyCredentialRequestOptionsJSON {
  try {
    const parsed = requestOptionsSchema.safeParse(JSON.parse(json))
    if (parsed.success) return parsed.data
  } catch {
    // not JSON: falls through
  }
  throw new PasskeyError('unknown')
}

export interface PasskeyDeps {
  readonly region: string
  readonly clientId: string
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchImpl
  /** Injected for tests; defaults to `navigator.credentials`. */
  readonly credentials?: PasskeyCredentials
}

/** The passkey calls for one app pool client. */
export function createPasskeyClient(deps: PasskeyDeps) {
  const idp = createCognitoIdpClient(deps.region, deps.fetchImpl)
  /** The credentials container, or `unsupported` when the browser cannot make passkeys. */
  const credentials = (): PasskeyCredentials => {
    const container = deps.credentials ?? browserCredentials()
    if (container === undefined || !hasJsonHelpers()) throw new PasskeyError('unsupported')
    return container
  }

  /** One call; any refusal or network failure becomes `unknown` unless `refusals` names its type. */
  async function call(target: string, payload: object, refusals: Readonly<Record<string, PasskeyErrorCode>> = {}): Promise<unknown> {
    try {
      return await idp.call(target, payload)
    } catch (error) {
      const code = error instanceof CognitoRefusal ? refusals[error.type] : undefined
      throw new PasskeyError(code ?? 'unknown')
    }
  }

  return {
    /** Whether the signed-in person already has at least one passkey. */
    async hasPasskey(accessToken: string): Promise<boolean> {
      const parsed = listCredentialsSchema.safeParse(await call('ListWebAuthnCredentials', { AccessToken: accessToken, MaxResults: 1 }))
      if (!parsed.success) throw new PasskeyError('unknown')
      return parsed.data.Credentials.length > 0
    },

    /** Creates a passkey on this device for the signed-in person and registers it with Cognito. */
    async register(accessToken: string): Promise<void> {
      const browser = credentials()
      const started = startRegistrationSchema.safeParse(await call('StartWebAuthnRegistration', { AccessToken: accessToken }))
      if (!started.success) throw new PasskeyError('unknown')
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(started.data.CredentialCreationOptions)
      const credential = await browserCredential(() => browser.create({ publicKey }))
      await call('CompleteWebAuthnRegistration', { AccessToken: accessToken, Credential: credentialJson(credential) })
    },

    /** Signs `username` in with a passkey: the tokens, or a PasskeyError (`no_passkey` when none is registered). */
    async signIn(username: string): Promise<AuthTokens> {
      const browser = credentials()
      const started = await call('InitiateAuth', {
        AuthFlow: 'USER_AUTH',
        ClientId: deps.clientId,
        AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'WEB_AUTHN' },
      }, { NotAuthorizedException: 'no_passkey', UserNotFoundException: 'no_passkey' })
      // Without a passkey Cognito offers another challenge (SELECT_CHALLENGE, PASSWORD...) instead.
      const challenge = webAuthnChallengeSchema.safeParse(started)
      if (!challenge.success) throw new PasskeyError('no_passkey')
      const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(
        requestOptionsOf(challenge.data.ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS),
      )
      const credential = await browserCredential(() => browser.get({ publicKey }))
      const answered = await call('RespondToAuthChallenge', {
        ChallengeName: 'WEB_AUTHN',
        ClientId: deps.clientId,
        Session: challenge.data.Session,
        ChallengeResponses: {
          USERNAME: challenge.data.ChallengeParameters.USERNAME ?? username,
          CREDENTIAL: JSON.stringify(credentialJson(credential)),
        },
      })
      const tokens = tokensOf(answered)
      if (tokens === null) throw new PasskeyError('unknown')
      return tokens
    },
  }
}

export type PasskeyClient = ReturnType<typeof createPasskeyClient>
