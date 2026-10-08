/**
 * Memory item vocabulary and the compact shape the model reads.
 *
 * The enums mirror the memory Lambda's item model (`lambda/api/memory_handler.py`,
 * brief §B). Only the listed fields reach the prompt: embeddings, owner subs,
 * hashed supporters and source refs (session / run ids) never do.
 */
import { z } from 'zod';
import { isRecord, pick } from '../format.js';

export const MEMORY_SCOPES = ['company', 'personal'] as const;
export const MEMORY_STATUSES = ['active', 'proposed', 'conflict', 'archived'] as const;
export const MEMORY_KINDS = ['product', 'customer', 'agents', 'working_style', 'strategy', 'objective', 'other'] as const;
export const MEMORY_RETENTIONS = ['long_term', 'dated', 'decay'] as const;

/** Statements are neutral one-liners (memory item `statement`, ≤ 500). */
export const MAX_MEMORY_STATEMENT = 500;

const MEMORY_FIELDS = [
  'memory_id', 'scope', 'status', 'kind', 'statement', 'supporters', 'confidence', 'source_kind', 'categories',
  'retention', 'expires_at', 'last_reinforced_at', 'conflicts_with', 'created_at',
] as const;

/** One memory item for the model; non-records are dropped. */
function summarizeMemory(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? pick(value, MEMORY_FIELDS, MAX_MEMORY_STATEMENT) : undefined;
}

export function summarizeMemories(values: readonly unknown[]): Record<string, unknown>[] {
  return values.flatMap((value) => {
    const summary = summarizeMemory(value);
    return summary === undefined ? [] : [summary];
  });
}

/** Keys that never reach the prompt, at any depth of a memory response. */
const PRIVATE_MEMORY_KEYS = new Set(['embedding', 'owner_sub', 'supporter_hashes', 'supporters_hashed', 'sources', 'pk', 'sk', 'gsi1pk', 'gsi1sk']);
const MAX_SCRUB_DEPTH = 6;

/**
 * A memory-API response with private keys removed at every depth — for
 * responses (the review queue) whose nesting is the API's to choose.
 */
export function scrubMemoryResponse(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((item) => scrubMemoryResponse(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_MEMORY_KEYS.has(key))
    .map(([key, item]) => [key, scrubMemoryResponse(item, depth + 1)]));
}

/** `POST /memory/retrieve` → `{items: [{memory_id, scope, kind, statement, supporters}]}`; lenient per item. */
const recalledItemSchema = z.object({
  memory_id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS).catch('other'),
  statement: z.string().min(1),
  supporters: z.number().int().nonnegative().catch(1),
});
export type RecalledMemory = z.infer<typeof recalledItemSchema>;

const retrieveResponseSchema = z.object({ items: z.array(z.unknown()).catch([]) }).loose();

/** The recalled items that parse; a malformed row is skipped, never fatal. */
export function parseRecalled(body: unknown): RecalledMemory[] {
  const parsed = retrieveResponseSchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.items.flatMap((item) => {
    const one = recalledItemSchema.safeParse(item);
    return one.success ? [one.data] : [];
  });
}
