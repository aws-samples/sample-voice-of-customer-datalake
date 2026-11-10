/**
 * @fileoverview The app's passkey actions on Amplify v6 (services/passkey.ts): sign in with a passkey,
 * register one for the signed-in person, list theirs and remove one (a lost or replaced device).
 * Every failure is a PasskeyError.
 *
 * @module services/passkeyAuth
 */
import { associateWebAuthnCredential, deleteWebAuthnCredential, listWebAuthnCredentials } from 'aws-amplify/auth'
import { authService } from './auth'
import { passkeySupported, toPasskeyError } from './passkey'
import { configureAmplify } from '../lib/amplify-config'
import { isPasskeyAvailable } from '../runtimeConfig'

/** One registered passkey, as the Account page lists it. */
export interface PasskeyInfo {
  readonly id: string
  /** The name the authenticator gave it (e.g. "iCloud Keychain"), when it gave one. */
  readonly name: string | undefined
  readonly createdAt: Date | undefined
}

/** Cognito answers at most 20 passkeys a page; a person never has more than a few. */
const PAGE_SIZE = 20
const MAX_PAGES = 5

/** Whether to offer passkeys at all: the deployment takes them and this browser can make them. */
export function canUsePasskeys(): boolean {
  return isPasskeyAvailable() && passkeySupported()
}

/** `call` with Amplify configured, its failure turned into a PasskeyError. */
async function passkeyCall<T>(call: () => Promise<T>): Promise<T> {
  configureAmplify()
  return call().catch((error: unknown) => { throw toPasskeyError(error) })
}

/** Every passkey of the signed-in person, from `nextToken` on (at most MAX_PAGES pages). */
async function listAll(nextToken?: string, page = 0): Promise<PasskeyInfo[]> {
  const answer = await listWebAuthnCredentials({ pageSize: PAGE_SIZE, nextToken })
  const here = answer.credentials.flatMap((credential): PasskeyInfo[] => (credential.credentialId === undefined
    ? []
    : [{ id: credential.credentialId, name: credential.friendlyCredentialName, createdAt: credential.createdAt }]))
  if (answer.nextToken === undefined || page + 1 >= MAX_PAGES) return here
  return [...here, ...await listAll(answer.nextToken, page + 1)]
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
  /** The signed-in person's passkeys. */
  list: (): Promise<PasskeyInfo[]> => passkeyCall(() => listAll()),
  /** Removes one of the signed-in person's passkeys: it can no longer sign in. */
  remove: (id: string): Promise<void> => passkeyCall(() => deleteWebAuthnCredential({ credentialId: id })),
}
