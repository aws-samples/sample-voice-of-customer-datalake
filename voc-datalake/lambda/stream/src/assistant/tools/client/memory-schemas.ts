/**
 * Argument schemas of the memory write tools (`remember`, `update_company_memory`
 * in `core`; the curation tools in the `memory` pack), shared with the SPA's approval
 * boundary (`frontend/src/assistant/approvals/memorySchemas.ts` imports this module).
 *
 * Pure on purpose: zod and other pure modules only, because the SPA bundles it.
 * The id schema is a parameter: the stream and the SPA each keep their own (the
 * same rule, different messages), and the SPA builds these schemas with its own.
 */
import { z } from 'zod';
import { MAX_MEMORY_STATEMENT, MEMORY_KINDS, MEMORY_RETENTIONS, MEMORY_SCOPES } from '../server/memory-shape.js';
import { isoDateSchema, nonEmpty } from './text-schemas.js';

export const MEMORY_RESOLVE_ACTIONS = ['keep_both', 'keep', 'replace', 'merge'] as const;
export const MAX_MERGE_IDS = 10;
export const MAX_MEMORY_REASON = 500;

const statement = nonEmpty(MAX_MEMORY_STATEMENT);
const reason = nonEmpty(MAX_MEMORY_REASON);

/** The six memory write schemas, built over the caller's id schema. */
export function buildMemoryArgSchemas(idSchema: z.ZodString) {
  const remember = z.object({
    scope: z.enum(MEMORY_SCOPES),
    statement,
    kind: z.enum(MEMORY_KINDS),
    retention: z.enum(MEMORY_RETENTIONS).optional(),
    expires_at: isoDateSchema.optional(),
  }).strict().refine(
    (args) => (args.retention === 'dated') === (args.expires_at !== undefined),
    { message: 'expires_at is required with retention "dated", and only then', path: ['expires_at'] },
  );

  const updateCompanyMemory = z.object({
    memory_id: idSchema,
    previous_statement: statement,
    statement,
    kind: z.enum(MEMORY_KINDS),
    supporters: z.number().int().min(0).optional(),
    reason,
  }).strict().refine((args) => args.statement !== args.previous_statement, {
    message: 'the new statement must differ from the current one', path: ['statement'],
  });

  const forgetMemory = z.object({ memory_id: idSchema, statement, reason }).strict();

  const confirmMemory = z.object({ memory_id: idSchema, statement }).strict();

  const mergeMemories = z.object({
    memory_ids: z.array(idSchema).max(MAX_MERGE_IDS).min(2)
      .refine((ids) => new Set(ids).size === ids.length, 'memory_ids must be distinct'),
    statement,
  }).strict();

  const resolveMemoryConflict = z.object({
    memory_id: idSchema,
    action: z.enum(MEMORY_RESOLVE_ACTIONS),
    winner_id: idSchema.optional(),
    statement: statement.optional(),
  }).strict()
    .refine((args) => (args.action === 'keep' || args.action === 'replace') === (args.winner_id !== undefined), {
      message: 'winner_id is required for keep and replace, and only for them', path: ['winner_id'],
    })
    .refine((args) => (args.action === 'merge' || args.action === 'replace') === (args.statement !== undefined), {
      message: 'statement is required for merge and replace, and only for them', path: ['statement'],
    });

  return { remember, updateCompanyMemory, forgetMemory, confirmMemory, mergeMemories, resolveMemoryConflict };
}
