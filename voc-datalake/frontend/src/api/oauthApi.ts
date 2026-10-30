/**
 * @fileoverview MCP OAuth sign-in API (docs/mcp.md → "OAuth sign-in"): the consent screen and
 * "my sign-ins" on the Connect page (`/connect/oauth/*`, lambda/shared/mcp_oauth_consent_routes.py).
 * Every response is parsed through api/oauthSchema.ts.
 *
 * @module api/oauthApi
 */
import { del, post } from './requestKit'
import { fetchApi } from './client'
import type { ConnectScope } from './connectSchema'
import {
  ConsentApprovalSchema, ConsentDescriptionSchema, GrantListResponseSchema, GrantRevokeResponseSchema,
} from './oauthSchema'
import type { ConsentDescription, OAuthGrant } from './oauthSchema'

const CONSENT_PATH = '/connect/oauth/consent'
const GRANTS_PATH = '/connect/oauth/grants'

/** TanStack Query key of "my sign-ins". */
export const OAUTH_GRANTS_KEY = ['connect', 'oauth', 'grants'] as const

export interface ConsentChoice {
  /** The MCP client's authorization query, exactly as it arrived on the consent page. */
  authorize_query: string
  scope: ConnectScope
  project_id?: string
}

export const oauthApi = {
  describeConsent: async (authorizeQuery: string): Promise<ConsentDescription> =>
    ConsentDescriptionSchema.parse(await fetchApi<unknown>(
      `${CONSENT_PATH}?authorize_query=${encodeURIComponent(authorizeQuery)}`)),

  approveConsent: async (choice: ConsentChoice): Promise<string> =>
    ConsentApprovalSchema.parse(await fetchApi<unknown>(CONSENT_PATH, post(choice))).redirect_to,

  listGrants: async (): Promise<OAuthGrant[]> =>
    GrantListResponseSchema.parse(await fetchApi<unknown>(GRANTS_PATH)).grants,

  revokeGrant: async (grantId: string): Promise<OAuthGrant> =>
    GrantRevokeResponseSchema.parse(await fetchApi<unknown>(`${GRANTS_PATH}/${encodeURIComponent(grantId)}`, del())).grant,
}
