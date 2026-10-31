/**
 * @fileoverview The app's passkey actions on Amplify v6 (services/passkey.ts): sign in with a passkey,
 * register one for the signed-in person, and whether they have one. Every failure is a PasskeyError.
 *
 * @module services/passkeyAuth
 */
import { associateWebAuthnCredential, listWebAuthnCredentials } from 'aws-amplify/auth'
import { authService } from './auth'
import { passkeySupported, toPasskeyError } from './passkey'
import { configureAmplify } from '../lib/amplify-config'
import { isPasskeyAvailable } from '../runtimeConfig'

/** Whether to offer passkeys at all: the deployment takes them and this browser can make them. */
export function canUsePasskeys(): boolean {
  return isPasskeyAvailable() && passkeySupported()
}

/** `call` with Amplify configured, its failure turned into a PasskeyError. */
async function passkeyCall<T>(call: () => Promise<T>): Promise<T> {
  configureAmplify()
  return call().catch((error: unknown) => { throw toPasskeyError(error) })
}

export const passkeyAuth = {
  /** Signs `username` in with a passkey and keeps the session like a password sign-in. */
  signIn: (username: string): Promise<void> => authService.signInWithPasskey(username),
  /** Creates a passkey on this device for the signed-in person and registers it with Cognito. */
  register: (): Promise<void> => passkeyCall(() => associateWebAuthnCredential()),
  /** Whether the signed-in person has at least one passkey. */
  hasPasskey: (): Promise<boolean> => passkeyCall(async () => {
    const { credentials } = await listWebAuthnCredentials({ pageSize: 1 })
    return credentials.length > 0
  }),
}
