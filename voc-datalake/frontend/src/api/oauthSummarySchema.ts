/**
 * @fileoverview The `oauth` block of the token list (`GET /connect/tokens`): whether MCP OAuth sign-in
 * is configured on this deployment and which clients can sign in (docs/mcp.md → "OAuth sign-in").
 * Its own module so connectSchema.ts and oauthSchema.ts can both use it without a cycle.
 *
 * @module api/oauthSummarySchema
 */
import { z } from 'zod'

/** Mirrors CLIENT_KINDS in shared/mcp_oauth_config.py. */
export const OAUTH_CLIENT_KINDS = ['kiro', 'claude-code', 'cursor', 'web'] as const
export type OAuthClientKind = (typeof OAUTH_CLIENT_KINDS)[number]

/** Off unless the backend says otherwise: a missing block hides the sign-in snippets. */
export const OAuthSummarySchema = z.object({
  enabled: z.boolean().catch(false),
  clients: z.array(z.object({ kind: z.enum(OAUTH_CLIENT_KINDS), name: z.string() })).catch([]),
}).catch({ enabled: false, clients: [] })
export type OAuthSummary = z.infer<typeof OAuthSummarySchema>
