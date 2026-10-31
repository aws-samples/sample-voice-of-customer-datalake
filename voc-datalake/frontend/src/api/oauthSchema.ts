/**
 * @fileoverview Runtime validation for MCP OAuth sign-in (docs/mcp.md → "OAuth sign-in"): the consent
 * API and "my sign-ins" (`/connect/oauth/*`, lambda/shared/mcp_oauth_consent_routes.py).
 *
 * Lenient like connectSchema.ts: a malformed grant row is dropped, an unknown scope reads as `read`
 * and an unknown status as expired, so the UI never shows a sign-in as wider or more alive than the
 * backend treats it. A redirect the browser is about to follow must be an http(s) URL here; oauthApi
 * then checks its destination (api/oauthRedirect.ts: the hosted UI, a loopback, or the request's own
 * callback) before the page may follow it.
 *
 * @module api/oauthSchema
 */
import { z } from 'zod'
import { CREDENTIAL_LIFECYCLE_FIELDS, lenientRows } from './connectSchema'
import { OAUTH_CLIENT_KINDS } from './oauthSummarySchema'

/** An absolute http(s) URL the browser may navigate to. */
const NavigableUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}, 'not an http(s) URL')

const GrantSchema = z.object({
  grant_id: z.string().min(1),
  client_kind: z.string().catch(''),
  client_name: z.string().catch(''),
  ...CREDENTIAL_LIFECYCLE_FIELDS,
  signed_in: z.boolean().catch(false),
})
export type OAuthGrant = z.infer<typeof GrantSchema>

export const GrantListResponseSchema = z.object({
  grants: z.unknown().transform(lenientRows(GrantSchema)),
})

export const GrantRevokeResponseSchema = z.object({ grant: GrantSchema })

/** What the consent page shows (`GET /connect/oauth/consent`). */
export const ConsentDescriptionSchema = z.discriminatedUnion('refused', [
  z.object({
    refused: z.literal(false),
    client_kind: z.enum(OAUTH_CLIENT_KINDS),
    client_name: z.string(),
    can_write: z.boolean(),
    can_run_agents: z.boolean(),
    loopback: z.boolean(),
    deny_redirect: NavigableUrlSchema,
  }),
  z.object({
    refused: z.literal(true),
    error: z.string(),
    error_description: z.string().catch(''),
    redirect_to: NavigableUrlSchema,
  }),
])
export type ConsentDescription = z.infer<typeof ConsentDescriptionSchema>

export const ConsentApprovalSchema = z.object({ redirect_to: NavigableUrlSchema })
