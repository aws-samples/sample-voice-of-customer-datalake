/**
 * @fileoverview Plain `fetch` calls to the regional Cognito user-pool endpoint (the JSON 1.1 API the
 * SDKs wrap), for the flows amazon-cognito-identity-js has no method for: the board pool's USER_AUTH
 * sign-in (services/boardAuth.ts) and the app pool's passkeys (services/passkey.ts). No state, no
 * storage, no logging: tokens never reach the console.
 *
 * @module services/cognitoIdp
 */
import {
  CognitoAccessToken, CognitoIdToken, CognitoRefreshToken, CognitoUserSession,
} from 'amazon-cognito-identity-js'
import { CognitoRefusal } from './boardCognito'
import type { AuthTokens } from './boardCognito'
import { nullOnRejection } from '../lib/rejections'

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** The global `fetch`, called late so a test's stub is the one used. */
export const globalFetch: FetchImpl = (input, init) => fetch(input, init)

/** A caller of one pool's region: `call(target, payload)` answers the parsed body. */
export interface CognitoIdpClient {
  /**
   * One `AWSCognitoIdentityProviderService.<target>` call. Resolves to the parsed body (null when it
   * is not JSON); rejects with a CognitoRefusal for a non-OK answer, or the fetch's own error offline.
   */
  call(target: string, payload: object): Promise<unknown>
}

export function createCognitoIdpClient(region: string, fetchImpl: FetchImpl = globalFetch): CognitoIdpClient {
  const endpoint = `https://cognito-idp.${region}.amazonaws.com/`
  return {
    async call(target, payload) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
        body: JSON.stringify(payload),
      })
      // A body that is not JSON reads as no body; the status still decides.
      const body: unknown = await response.json().catch(nullOnRejection)
      if (!response.ok) throw new CognitoRefusal(body)
      return body
    },
  }
}

/** The SDK session for tokens a direct call returned, ready for `CognitoUser.setSignInUserSession`. */
export function sessionFromTokens(tokens: AuthTokens): CognitoUserSession {
  return new CognitoUserSession({
    IdToken: new CognitoIdToken({ IdToken: tokens.IdToken }),
    AccessToken: new CognitoAccessToken({ AccessToken: tokens.AccessToken }),
    RefreshToken: new CognitoRefreshToken({ RefreshToken: tokens.RefreshToken }),
  })
}
