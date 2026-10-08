/**
 * @fileoverview Runtime validation for the Connect page's personal MCP token API
 * (`/connect/tokens`, lambda/api/mcp_tokens_handler.py) — todofeatures §6.3.
 *
 * Lenient at the boundary like every list in this app (see feedbackSchema.ts):
 * a malformed row is dropped rather than blanking the page, and a field that
 * arrives misshapen falls back to the reading the BACKEND enforces —
 * `shared/mcp_global_tokens.py` reads an unknown scope as `read` and an
 * unreadable status as expired, so the UI never shows a credential as wider or
 * more alive than it is.
 *
 * `z.object` (not loose): unknown keys are stripped, so a secret hash or a
 * Cognito subject added to a response by mistake never reaches a component.
 *
 * @module api/connectSchema
 */
import { z } from 'zod'

/** Mirrors VALID_SCOPES in shared/mcp_global_tokens.py. */
export const CONNECT_SCOPES = ['read', 'write'] as const
export type ConnectScope = (typeof CONNECT_SCOPES)[number]

const TOKEN_STATUSES = ['active', 'revoked', 'expired'] as const
export type TokenStatus = (typeof TOKEN_STATUSES)[number]

const AUDIT_OUTCOMES = ['ok', 'error', 'denied', 'failed'] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/** Lifetimes the mint form offers; the backend accepts any 1–90 (MAX_EXPIRY_DAYS in shared/mcp_global_tokens.py). */
export const EXPIRY_CHOICES = [7, 30, 90] as const
export const DEFAULT_EXPIRY_DAYS = 30
const MAX_EXPIRY_DAYS = 90
/** Mirrors MAX_TOKEN_NAME_LENGTH in shared/mcp_global_tokens.py. */
export const MAX_TOKEN_NAME_LENGTH = 80

export function isConnectScope(value: string): value is ConnectScope {
  return CONNECT_SCOPES.some((scope) => scope === value)
}

const optionalText = z.string().nullable().optional().catch(undefined)
  .transform((value) => (value == null || value === '' ? undefined : value))

const ConnectTokenSchema = z.object({
  token_id: z.string().min(1),
  name: z.string().catch(''),
  scope: z.enum(CONNECT_SCOPES).catch('read'),
  project_id: optionalText,
  created_at: z.string().catch(''),
  expires_at: optionalText,
  last_used_at: optionalText,
  revoked_at: optionalText,
  status: z.enum(TOKEN_STATUSES).catch('expired'),
  can_run_agents: z.boolean().catch(false),
})
export type ConnectToken = z.infer<typeof ConnectTokenSchema>

/** Rows that fail ``schema`` are dropped (a row without an id cannot be keyed or revoked). */
function lenientRows<T>(schema: z.ZodType<T>) {
  return (raw: unknown): T[] => {
    if (!Array.isArray(raw)) return []
    return raw.flatMap((row) => {
      const parsed = schema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  }
}

const LimitsSchema = z.object({
  default_expiry_days: z.number().int().positive().catch(DEFAULT_EXPIRY_DAYS),
  max_expiry_days: z.number().int().positive().catch(MAX_EXPIRY_DAYS),
  max_active_tokens: z.number().int().positive().catch(20),
}).catch({ default_expiry_days: DEFAULT_EXPIRY_DAYS, max_expiry_days: MAX_EXPIRY_DAYS, max_active_tokens: 20 })

export const TokenListResponseSchema = z.object({
  tokens: z.unknown().transform(lenientRows(ConnectTokenSchema)),
  endpoint_path: z.string().startsWith('/').catch('/mcp/global'),
  can_mint_agent_runner: z.boolean().catch(false),
  limits: LimitsSchema,
})
export type TokenListResponse = z.infer<typeof TokenListResponseSchema>

/** The mint answer: the only time the raw credential exists in the browser. */
export const MintResponseSchema = ConnectTokenSchema.extend({ token: z.string().startsWith('voc_') })
export type MintResponse = z.infer<typeof MintResponseSchema>

const AuditEventSchema = z.object({
  tool: z.string().catch(''),
  at: z.string().catch(''),
  project_id: optionalText,
  outcome: z.enum(AUDIT_OUTCOMES).catch('failed'),
})

export const TokenDetailResponseSchema = z.object({
  token: ConnectTokenSchema,
  events: z.unknown().transform(lenientRows(AuditEventSchema)),
  next_cursor: optionalText,
})
export type TokenDetailResponse = z.infer<typeof TokenDetailResponseSchema>

export const RevokeResponseSchema = z.object({ token: ConnectTokenSchema })
