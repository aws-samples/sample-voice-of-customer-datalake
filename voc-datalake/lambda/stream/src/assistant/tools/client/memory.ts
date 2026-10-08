/**
 * Memory write tools. `remember` and `update_company_memory` are `core` (every
 * page recalls memory, so a contradiction can surface anywhere); the curation
 * tools are the `memory` pack. None is admin-gated here: the memory Lambda
 * applies the rules (company adds/edits by a non-admin, non-reviewer are
 * stored as `proposed` for review; forget/merge/resolve of company memories
 * need an admin or memory reviewer; personal memories are the owner's).
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import { idProperty, idSchema } from '../spec.js';
import {
  MAX_MEMORY_STATEMENT,
  MEMORY_KINDS,
  MEMORY_RETENTIONS,
  MEMORY_SCOPES,
} from '../server/memory-shape.js';
import { defineClientTool, idListSchema, isoDateSchema, q, stringProperty } from './define.js';

const MEMORY_RESOLVE_ACTIONS = ['keep_both', 'keep', 'replace', 'merge'] as const;
const MAX_MERGE_IDS = 10;
const MAX_REASON = 500;

const statement = z.string().trim().min(1).max(MAX_MEMORY_STATEMENT);

const STATEMENT = stringProperty('One neutral, self-contained sentence (no names, quotes, judgments of people).', MAX_MEMORY_STATEMENT);
const MEMORY_ID = idProperty('Memory id (from search_memory or the <memory> block).');

const remember = defineClientTool({
  name: 'remember',
  pack: 'core',
  description: 'Save something worth remembering. scope "company" = generic and valuable for the company (any '
    + 'product, customer or project knowledge), visible to EVERYONE; scope "personal" = specific to this user '
    + '(their working style, preferences), visible to them only. Examples: "I like you to reply in short" → '
    + 'personal; "Our customer demonstrated they xx and xx" → company. retention: long_term (never expires), '
    + 'dated (needs expires_at, e.g. a quarter objective ends at quarter end), decay (default: archived after 90 '
    + 'days unused).',
  properties: {
    scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'company or personal.' },
    statement: STATEMENT,
    kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'What it is about.' },
    retention: { type: 'string', enum: [...MEMORY_RETENTIONS], description: 'Default decay.' },
    expires_at: stringProperty('YYYY-MM-DD; required with retention "dated".', 10),
  },
  required: ['scope', 'statement', 'kind'],
  // jscpd:ignore-start — mirrors frontend/src/assistant/approvals/memorySchemas.ts on purpose: separate packages, pinned by newTools.lockstep.test.ts
  schema: z.object({
    scope: z.enum(MEMORY_SCOPES),
    statement,
    kind: z.enum(MEMORY_KINDS),
    retention: z.enum(MEMORY_RETENTIONS).optional(),
    expires_at: isoDateSchema.optional(),
  }).strict().refine(
    (args) => (args.retention === 'dated') === (args.expires_at !== undefined),
    { message: 'expires_at is required with retention "dated", and only then', path: ['expires_at'] },
  ),
  // jscpd:ignore-end of the accepted pair
  summarize: (args) => `Remember (${args.scope}): ${q(args.statement, 160)}`,
});

const updateCompanyMemory = defineClientTool({
  name: 'update_company_memory',
  pack: 'core',
  description: 'Change what the company remembers, for everyone — the "N people said X — is it now Y?" flow. Only '
    + 'after the user confirmed that the company memory should change. Send the memory\u2019s current statement and '
    + 'supporter count (from search_memory) so the card shows what changes. An administrator or memory reviewer '
    + 'updates it in place; for anyone else the new statement is filed as a proposal for review.',
  properties: {
    memory_id: MEMORY_ID,
    previous_statement: stringProperty('The current statement, as read.', MAX_MEMORY_STATEMENT),
    statement: stringProperty('The new statement.', MAX_MEMORY_STATEMENT),
    kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Kind of the memory.' },
    supporters: { type: 'integer', minimum: 0, description: 'How many people support the current statement.' },
    reason: stringProperty('Why it changed, in the user\u2019s words.', MAX_REASON),
  },
  required: ['memory_id', 'previous_statement', 'statement', 'kind', 'reason'],
  // jscpd:ignore-start — mirrors frontend/src/assistant/approvals/memorySchemas.ts on purpose: separate packages, pinned by newTools.lockstep.test.ts
  schema: z.object({
    memory_id: idSchema,
    previous_statement: statement,
    statement,
    kind: z.enum(MEMORY_KINDS),
    supporters: z.number().int().min(0).optional(),
    reason: z.string().trim().min(1).max(MAX_REASON),
  }).strict().refine((args) => args.statement !== args.previous_statement, {
    message: 'the new statement must differ from the current one', path: ['statement'],
  }),
  // jscpd:ignore-end of the accepted pair
  summarize: (args) => `Update company memory ${args.memory_id} for everyone: ${q(args.previous_statement, 80)} → ${q(args.statement, 80)}`,
});

const forgetMemory = defineClientTool({
  name: 'forget_memory',
  pack: 'memory',
  description: 'Forget a memory: it is archived and tombstoned, so automation never learns it again (an '
    + 'administrator can restore it). Only when the user asks.',
  properties: {
    memory_id: MEMORY_ID,
    statement: stringProperty('Its statement, as read (shown on the card).', MAX_MEMORY_STATEMENT),
    reason: stringProperty('Why, shown to the user.', MAX_REASON),
  },
  required: ['memory_id', 'statement', 'reason'],
  schema: z.object({ memory_id: idSchema, statement, reason: z.string().trim().min(1).max(MAX_REASON) }).strict(),
  summarize: (args) => `FORGET memory ${args.memory_id}: ${q(args.statement, 120)}`,
});

const confirmMemory = defineClientTool({
  name: 'confirm_memory',
  pack: 'memory',
  description: 'Add the user\u2019s +1 to a memory they agree with (counts once per person; refreshes it so it '
    + 'does not expire).',
  properties: {
    memory_id: MEMORY_ID,
    statement: stringProperty('Its statement, as read (shown on the card).', MAX_MEMORY_STATEMENT),
  },
  required: ['memory_id', 'statement'],
  schema: z.object({ memory_id: idSchema, statement }).strict(),
  summarize: (args) => `Confirm (+1) memory ${args.memory_id}: ${q(args.statement, 120)}`,
});

const mergeMemories = defineClientTool({
  name: 'merge_memories',
  pack: 'memory',
  description: 'Merge 2-10 memories of the same scope into one statement; supporters are combined and the '
    + 'originals archived. Company merges need an administrator or memory reviewer.',
  properties: {
    memory_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: MAX_MERGE_IDS, description: 'Memories to merge.' },
    statement: stringProperty('The merged statement.', MAX_MEMORY_STATEMENT),
  },
  required: ['memory_ids', 'statement'],
  schema: z.object({
    memory_ids: idListSchema(MAX_MERGE_IDS).min(2)
      .refine((ids) => new Set(ids).size === ids.length, 'memory_ids must be distinct'),
    statement,
  }).strict(),
  summarize: (args) => `MERGE ${args.memory_ids.length} memories into ${q(args.statement, 120)}`,
});

function summarizeResolution(args: { memory_id: string; action: string; winner_id?: string; statement?: string }): string {
  const parts = [`Resolve memory ${args.memory_id}: ${args.action.replaceAll('_', ' ')}`];
  if (args.winner_id !== undefined) parts.push(`(winner ${args.winner_id})`);
  if (args.statement !== undefined) parts.push(`→ ${q(args.statement, 100)}`);
  return parts.join(' ');
}

const resolveMemoryConflict = defineClientTool({
  name: 'resolve_memory_conflict',
  pack: 'memory',
  description: 'Resolve a memory in the review queue (from get_memory_review): keep_both (both stay, unlinked), '
    + 'keep (winner_id stays, the other is archived), replace (winner_id stays with the new statement, the other '
    + 'is archived), merge (one new statement, supporters combined). Administrators and memory reviewers.',
  properties: {
    memory_id: idProperty('The review item\u2019s memory id.'),
    action: { type: 'string', enum: [...MEMORY_RESOLVE_ACTIONS], description: 'How to resolve it.' },
    winner_id: idProperty('The memory that wins (keep / replace).'),
    statement: stringProperty('The new statement (replace / merge).', MAX_MEMORY_STATEMENT),
  },
  required: ['memory_id', 'action'],
  schema: z.object({
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
    }),
  summarize: summarizeResolution,
});

/** Core-pack memory writes (offered on every page). */
export function createCoreMemoryClientTools(): ClientToolDefinition[] {
  return [remember, updateCompanyMemory];
}

/** `memory` pack curation writes. */
export function createMemoryClientTools(): ClientToolDefinition[] {
  return [forgetMemory, confirmMemory, mergeMemories, resolveMemoryConflict];
}
