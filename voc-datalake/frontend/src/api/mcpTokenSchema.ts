/**
 * @fileoverview Runtime validation/normalization for MCP token API responses,
 * plus the credential vocabulary the mint form offers.
 *
 * The token list was the one list boundary in this app consumed as a declared
 * type with no runtime check — every other one normalizes through a lenient
 * Zod schema (see api/feedbackSchema.ts, api/scrapersSchema.ts,
 * pages/FeedbackForms/formSchema.ts). It matters more here than it looks: a
 * token row describes what a credential is allowed to do, so a field that
 * silently arrives missing or misshapen makes the UI describe a credential's
 * reach differently from how the backend enforces it.
 *
 * Defaults mirror the backend's own reading of a partial row
 * (shared/mcp_tokens.py): an absent read_reach is 'workspace', because that is
 * what enforcement assumes. Choosing a *safer-looking* default here would be
 * the wrong call — it would show a credential as narrower than it really is.
 *
 * @module api/mcpTokenSchema
 */
import { z } from 'zod'
import type { ApiToken } from './types'

/**
 * How far a credential may read. Mirrors VALID_READ_REACHES in
 * shared/mcp_tokens.py; the backend rejects anything else at mint time.
 *
 * - `workspace` — the default, and NOT the harmless option: it reaches every
 *   project's personas and documents plus the whole feedback corpus.
 * - `project-set` — sealed to the credential's own projects. Cannot read the
 *   feedback corpus at all, because that data has no project dimension to
 *   narrow (the backend refuses rather than pretending).
 * - `none` — reads nothing. Offered for completeness; with no write tools yet
 *   it produces an inert credential, so the form does not present it.
 */
export const READ_REACHES = ['workspace', 'project-set', 'none'] as const
export type ReadReach = (typeof READ_REACHES)[number]

/** The reaches worth offering at mint time — see `none` above. */
export const OFFERED_READ_REACHES: readonly ReadReach[] = ['workspace', 'project-set']

export const DEFAULT_READ_REACH: ReadReach = 'workspace'

export function isReadReach(value: string): value is ReadReach {
  return READ_REACHES.some((reach) => reach === value)
}

/**
 * Per-domain scopes. Mirrors VALID_SCOPES in shared/mcp_tokens.py.
 *
 * Deliberately only the scopes that grant something today. The retired
 * `read` / `read-write` pair had a phantom half: `read-write` was mintable,
 * stored and badged in this UI while no tool ever required it.
 */
export const MCP_SCOPES = ['feedback:read', 'metrics:read', 'projects:read'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export const DEFAULT_SCOPES: readonly McpScope[] = MCP_SCOPES

export function isMcpScope(value: string): value is McpScope {
  return MCP_SCOPES.some((scope) => scope === value)
}

/** Keep recognised scopes, drop junk elements rather than discarding the row. */
const scopeArraySchema = z
  .array(z.unknown())
  .catch(() => [])
  .transform((items) => items.filter((item): item is McpScope =>
    typeof item === 'string' && isMcpScope(item)))

/** Keep string project ids, drop junk elements. */
const projectArraySchema = z
  .array(z.unknown())
  .catch(() => [])
  .transform((items) => items.filter((item): item is string =>
    typeof item === 'string' && item !== ''))

/** Absent/'' stay undefined so the row reads as "never used" / "never expires"
 *  rather than rendering an Invalid Date. */
const optionalIsoString = z
  .string()
  .optional()
  .nullable()
  .catch(undefined)
  .transform((value) => (value == null || value === '' ? undefined : value))

/**
 * A stored token row as the list endpoint reports it.
 *
 * `token_id` is the one field that cannot be invented: it keys the React list
 * and addresses the revoke endpoint, so rows without one are dropped by
 * `normalizeApiTokens` rather than rendered with an undefined key.
 *
 * Loose object so fields the backend adds later pass through untouched.
 */
export const ApiTokenSchema = z.looseObject({
  token_id: z.string().min(1),
  name: z.string().catch(''),
  scopes: scopeArraySchema,
  projects: projectArraySchema,
  read_reach: z.enum(READ_REACHES).catch(DEFAULT_READ_REACH),
  created_at: z.string().catch(''),
  last_used_at: optionalIsoString,
  expires_at: optionalIsoString,
}).transform((row) => {
  // Drop fields that must never reach a component, even though the object is
  // loose. The backend sends neither — the point is that `looseObject` passes
  // unknown keys straight through, so "the backend doesn't send it" is the only
  // thing standing between a future response change and a credential digest or
  // a Cognito subject landing in a React tree or a console log.
  //
  // Belt and braces: the backend test `test_list_never_returns_the_secret_hash`
  // is the primary guarantee; this is the one that holds if that regresses.
  //
  // Copy-and-delete rather than rest-destructuring so the row keeps its inferred
  // type (a `...rest` spread widens it to an index signature, and asserting it
  // back would need the type assertion this codebase forbids).
  if (!('secret_hash' in row) && !('created_by' in row)) return row
  const cleaned = { ...row }
  delete cleaned.secret_hash
  delete cleaned.created_by
  return cleaned
})

/**
 * Normalize a token list payload, dropping only rows with no usable id.
 *
 * Never throws: a malformed payload yields an empty list, which the tab
 * renders as its empty state, instead of blanking the route.
 */
export function normalizeApiTokens(raw: unknown): ApiToken[] {
  if (!Array.isArray(raw)) {
    if (raw != null) {
      // The TYPE, not the payload. Token names and project ids are not secrets,
      // but logging a whole response body is the habit that eventually logs one.
      console.warn(`[mcpTokenSchema] token list was not an array (got ${typeof raw}); ignoring`)
    }
    return []
  }
  const tokens: ApiToken[] = []
  for (const row of raw) {
    const parsed = ApiTokenSchema.safeParse(row)
    if (parsed.success) {
      tokens.push(parsed.data)
    } else {
      // A row with no token_id cannot be keyed or revoked, so it is dropped —
      // loudly, because an unrevocable credential is worth an operator's
      // attention.
      console.warn('[mcpTokenSchema] dropping token row without a usable token_id')
    }
  }
  return tokens
}

/** The mint response. `token` is the only time the raw credential exists here. */
export const CreateApiTokenResponseSchema = z.looseObject({
  token: z.string().min(1),
  token_id: z.string().catch(''),
  name: z.string().catch(''),
  scopes: scopeArraySchema,
  projects: projectArraySchema,
  read_reach: z.enum(READ_REACHES).catch(DEFAULT_READ_REACH),
  expires_at: optionalIsoString,
})
