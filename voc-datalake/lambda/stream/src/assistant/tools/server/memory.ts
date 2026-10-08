/**
 * Memory server tools: `search_memory` (core — every page) and
 * `get_memory_review` (memory pack). Both read the memory Lambda as the
 * caller, so its rules apply unchanged: personal memories are the caller's own
 * only, the review queue answers 403 to anyone who is neither an admin nor a
 * memory reviewer.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { isRecord, jsonResult } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import { recordsAt } from './feedback-shape.js';
import { serverTool } from './common.js';
import {
  MAX_MEMORY_STATEMENT,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  scrubMemoryResponse,
  summarizeMemories,
} from './memory-shape.js';

const searchInput = z.object({
  mode: z.enum(['search', 'conflicts']).optional(),
  query: z.string().trim().min(1).max(MAX_MEMORY_STATEMENT).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
}).strict().refine((args) => args.mode !== 'conflicts' || args.query !== undefined, {
  message: 'mode "conflicts" needs the new statement in query',
  path: ['query'],
});
type SearchArgs = z.infer<typeof searchInput>;

/** Rows per scope handed to the model; the route pages further with a cursor we do not follow. */
const MAX_ROWS_PER_SCOPE = 25;

async function listScope(deps: ToolDeps, ctx: AssistantRunContext, scope: (typeof MEMORY_SCOPES)[number], args: SearchArgs) {
  const body = await deps.invoke({
    fn: 'memory',
    method: 'GET',
    path: '/memory',
    resource: '/memory',
    query: { scope, q: args.query, kind: args.kind, status: args.status },
  }, ctx.claims);
  const items = recordsAt(body, 'items');
  const more = isRecord(body) && typeof body.next_cursor === 'string' && body.next_cursor.length > 0;
  return {
    scope,
    returned: Math.min(items.length, MAX_ROWS_PER_SCOPE),
    ...(more || items.length > MAX_ROWS_PER_SCOPE ? { more: true } : {}),
    items: summarizeMemories(items.slice(0, MAX_ROWS_PER_SCOPE)),
  };
}

async function checkConflicts(deps: ToolDeps, ctx: AssistantRunContext, statement: string) {
  const body = await deps.invoke({
    fn: 'memory',
    method: 'GET',
    path: '/memory/conflict-check',
    resource: '/memory/conflict-check',
    query: { statement },
  }, ctx.claims);
  const conflicts = summarizeMemories(recordsAt(body, 'conflicts'));
  return {
    statement,
    count: conflicts.length,
    conflicts,
    ...(conflicts.length > 0
      ? { next: 'Ask the user: "<supporters> people said <statement> — is it now <their statement>? Update it for everyone?" before proposing update_company_memory.' }
      : {}),
  };
}

/** The statement to conflict-check: searchInput's refine guarantees one in mode "conflicts". */
function conflictStatement(args: SearchArgs): string | undefined {
  return args.mode === 'conflicts' ? args.query : undefined;
}

function searchMemoryTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'search_memory',
    'Look up what this workspace remembers. mode "search" (default) lists memories — company ones (shared by '
      + 'everyone) and the user\u2019s own personal ones — optionally filtered by text, scope, kind and status; '
      + 'supporters = how many people said it. mode "conflicts" checks a NEW statement (in query) against active '
      + 'company memories and returns the ones it contradicts, with their supporter counts.',
    {
      mode: { type: 'string', enum: ['search', 'conflicts'], description: 'search (default) or conflicts.' },
      query: { type: 'string', maxLength: MAX_MEMORY_STATEMENT, description: 'Text to match; for conflicts, the new statement.' },
      scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'Only company or only personal (default both).' },
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Only this kind.' },
      status: { type: 'string', enum: [...MEMORY_STATUSES], description: 'Only this status (default: as the API lists).' },
    },
  );
  return serverTool('search_memory', 'core', spec, async (input, ctx) => {
    const args = parseToolInput(searchInput, input);
    const statement = conflictStatement(args);
    if (statement !== undefined) {
      return { content: jsonResult(await checkConflicts(deps, ctx, statement)) };
    }
    const scopes = args.scope === undefined ? MEMORY_SCOPES : [args.scope];
    const results = await Promise.all(scopes.map((scope) => listScope(deps, ctx, scope, args)));
    return { content: jsonResult({ results }) };
  });
}

function getMemoryReviewTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_memory_review',
    'The memory review queue (administrators and memory reviewers): proposed company memories and conflicts side '
      + 'by side, with supporter counts, alignment with company objectives and a suggested resolution. Use it before '
      + 'proposing resolve_memory_conflict or merge_memories.',
    {},
  );
  return serverTool('get_memory_review', 'memory', spec, async (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    const body = await deps.invoke({ fn: 'memory', method: 'GET', path: '/memory/review', resource: '/memory/review' }, ctx.claims);
    return { content: jsonResult(scrubMemoryResponse(body)) };
  });
}

export function createMemoryServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [searchMemoryTool(deps), getMemoryReviewTool(deps)];
}
