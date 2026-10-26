/**
 * @fileoverview Argument schemas of the memory write tools (`remember`,
 * `update_company_memory` in `core`; the curation tools in `memory`) — a strict
 * mirror of `lambda/stream/src/assistant/tools/client/memory.ts`.
 *
 * @module assistant/approvals/memorySchemas
 */
import { z } from 'zod'
import { idSchema, isoDateSchema, nonEmpty } from './schemas'

export const MEMORY_SCOPES = ['company', 'personal'] as const
export const MEMORY_KINDS = ['product', 'customer', 'agents', 'working_style', 'strategy', 'objective', 'other'] as const
export const MEMORY_RETENTIONS = ['long_term', 'dated', 'decay'] as const
export const MEMORY_RESOLVE_ACTIONS = ['keep_both', 'keep', 'replace', 'merge'] as const
export const MAX_MEMORY_STATEMENT = 500
const MAX_MERGE_IDS = 10
const MAX_REASON = 500

const statement = nonEmpty(MAX_MEMORY_STATEMENT)
const reason = nonEmpty(MAX_REASON)

// jscpd:ignore-start — mirrors lambda/stream/src/assistant/tools/client/memory.ts on purpose: separate packages, pinned by newTools.lockstep.test.ts
export const rememberArgs = z.strictObject({
  scope: z.enum(MEMORY_SCOPES),
  statement,
  kind: z.enum(MEMORY_KINDS),
  retention: z.enum(MEMORY_RETENTIONS).optional(),
  expires_at: isoDateSchema.optional(),
}).refine((a) => (a.retention === 'dated') === (a.expires_at !== undefined), {
  message: 'expires_at is required with retention "dated", and only then', path: ['expires_at'],
})

export const updateCompanyMemoryArgs = z.strictObject({
  memory_id: idSchema,
  previous_statement: statement,
  statement,
  kind: z.enum(MEMORY_KINDS),
  supporters: z.number().int().min(0).optional(),
  reason,
}).refine((a) => a.statement !== a.previous_statement, {
  message: 'the new statement must differ from the current one', path: ['statement'],
})
// jscpd:ignore-end of the accepted pair

export const forgetMemoryArgs = z.strictObject({ memory_id: idSchema, statement, reason })

export const confirmMemoryArgs = z.strictObject({ memory_id: idSchema, statement })

export const mergeMemoriesArgs = z.strictObject({
  memory_ids: z.array(idSchema).min(2).max(MAX_MERGE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'memory_ids must be distinct'),
  statement,
})

export const resolveMemoryConflictArgs = z.strictObject({
  memory_id: idSchema,
  action: z.enum(MEMORY_RESOLVE_ACTIONS),
  winner_id: idSchema.optional(),
  statement: statement.optional(),
})
  .refine((a) => (a.action === 'keep' || a.action === 'replace') === (a.winner_id !== undefined), {
    message: 'winner_id is required for keep and replace, and only for them', path: ['winner_id'],
  })
  .refine((a) => (a.action === 'merge' || a.action === 'replace') === (a.statement !== undefined), {
    message: 'statement is required for merge and replace, and only for them', path: ['statement'],
  })

export type RememberArgs = z.infer<typeof rememberArgs>
export type UpdateCompanyMemoryArgs = z.infer<typeof updateCompanyMemoryArgs>
export type ForgetMemoryArgs = z.infer<typeof forgetMemoryArgs>
export type ConfirmMemoryArgs = z.infer<typeof confirmMemoryArgs>
export type MergeMemoriesArgs = z.infer<typeof mergeMemoriesArgs>
export type ResolveMemoryConflictArgs = z.infer<typeof resolveMemoryConflictArgs>
