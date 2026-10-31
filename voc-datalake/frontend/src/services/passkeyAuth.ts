/**
 * @fileoverview The app's passkey actions (services/passkey.ts) bound to its own user pool and session:
 * sign in with a passkey, register one for the signed-in person, and whether they have one.
 *
 * @module services/passkeyAuth
 */
import { authService } from './auth'
import { createPasskeyClient, passkeySupported } from './passkey'
import type { PasskeyClient } from './passkey'
import { AuthError } from '../lib/errors'
import { getRuntimeConfig, isPasskeyAvailable } from '../runtimeConfig'
import { useAuthStore } from '../store/authStore'

/** Whether to offer passkeys at all: the deployment takes them and this browser can make them. */
export function canUsePasskeys(): boolean {
  return isPasskeyAvailable() && passkeySupported()
}

function client(): PasskeyClient {
  const { region, clientId } = getRuntimeConfig().cognito
  return createPasskeyClient({ region, clientId })
}

function accessToken(): string {
  const token = useAuthStore.getState().accessToken
  if (token === null || token === '') throw new AuthError('Not signed in')
  return token
}

export const passkeyAuth = {
  /** Signs `username` in with a passkey and keeps the session like a password sign-in. */
  signIn: async (username: string): Promise<void> => {
    authService.adoptTokens(await client().signIn(username.trim()))
  },
  /** Creates and registers a passkey for the signed-in person. */
  register: (): Promise<void> => client().register(accessToken()),
  /** Whether the signed-in person has at least one passkey. */
  hasPasskey: (): Promise<boolean> => client().hasPasskey(accessToken()),
}
