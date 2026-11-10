/**
 * @fileoverview Opt-in passkeys for the app user pool (docs/deployment.md -> Passkeys): what the UI
 * needs to know about them, independent of how they are called. The calls themselves are Amplify
 * v6's (`associateWebAuthnCredential`, `listWebAuthnCredentials`, `signIn` with the choice-based
 * `USER_AUTH` flow preferring `WEB_AUTHN`), in services/passkeyAuth.ts and services/auth.ts.
 *
 * @module services/passkey
 */

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

/** Whether this browser can create and use passkeys (WebAuthn). */
export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'
    && typeof navigator !== 'undefined' && 'credentials' in navigator
}

/** Amplify's passkey error names (its `PasskeyErrorCode`) and the reason each is shown as. */
const AMPLIFY_PASSKEY_ERRORS: Readonly<Record<string, PasskeyErrorCode>> = {
  PasskeyRegistrationCanceled: 'cancelled',
  PasskeyAuthenticationCanceled: 'cancelled',
  PasskeyOperationAborted: 'cancelled',
  PasskeyNotSupported: 'unsupported',
  // A browser's own WebAuthn refusal (prompt closed or timed out), when it reaches us unwrapped.
  NotAllowedError: 'cancelled',
}

/** The PasskeyError for whatever a passkey call threw (an unknown failure is `unknown`). */
export function toPasskeyError(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  return new PasskeyError(AMPLIFY_PASSKEY_ERRORS[name] ?? 'unknown')
}
