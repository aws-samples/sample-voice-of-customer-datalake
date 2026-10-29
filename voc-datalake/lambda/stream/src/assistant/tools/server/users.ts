/**
 * User-administration reads of the `settings` pack (admin-only): `list_users`
 * and `get_user_access`, synchronous invokes of the Users API as the caller
 * (its routes are `require_admin`, so a non-admin is refused twice: here,
 * before any invoke, and by the route itself).
 *
 * The directory is sensitive: only allowlisted fields reach the model — never
 * a user's Cognito `sub` (category owners and access rows are keyed by it) nor
 * the user flags — strings are clipped, and the listing is capped.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { isRecord } from '../../../lib/is-record.js';
import { jsonResult, pick } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import { USERNAME_PATTERN, USER_LIMITS } from '../client/user-schemas.js';
import { recordsAt } from './feedback-shape.js';
import { seg, serverTool } from './common.js';

/** The listed-user keys the model may read (no `sub`, no `flags`, no `last_modified`). */
const USER_FIELDS = ['username', 'email', 'name', 'given_name', 'family_name', 'groups', 'status', 'enabled', 'created_at'] as const;
/** Users a listing carries at most; a longer directory is cut and says so. */
export const MAX_LISTED_USERS = 500;
/**
 * Characters the listed rows may use — about 500 lean rows or 240 typical ones
 * (the default result budget holds ~50). What does not fit is cut at a row
 * boundary and flagged, so the model always reads valid JSON.
 */
const USERS_RESULT_BUDGET = 60_000;
/** `{"count":…,"users":[…],"truncated":true}` around the rows. */
const ENVELOPE_CHARS = 100;
const MAX_USER_STRING = 200;

const noInput = z.object({}).strict();
const usernameInput = z.object({
  username: z.string().trim().regex(USERNAME_PATTERN, 'must be a Cognito username from list_users'),
}).strict();

/**
 * The access answer, lenient: `sources` keeps its three meanings (`['*']`,
 * a list, null = the default rule), so it is read explicitly rather than
 * through `pick`, which drops nulls.
 */
const accessBodySchema = z.object({
  all: z.boolean().catch(false),
  categories: z.array(z.string()).catch([]),
  sources: z.array(z.string()).nullable().catch(null),
  owned_categories: z.array(z.string()).catch([]),
});

function requireAdmin(ctx: AssistantRunContext, name: string): void {
  if (!ctx.isAdmin) throw new AssistantToolError('not_permitted', `${name} is only available to administrators.`);
}

/** `GET /users` as the caller: the user rows (lenient: non-records are dropped). */
export async function readUsers(deps: Pick<ToolDeps, 'invoke'>, ctx: AssistantRunContext): Promise<Record<string, unknown>[]> {
  const body = await deps.invoke({ fn: 'users', method: 'GET', path: '/users', resource: '/users' }, ctx.claims);
  return recordsAt(body, 'users');
}

/** The longest prefix of `rows` whose JSON (rows plus separating commas) fits `budget`. */
function fittingPrefix(rows: readonly Record<string, unknown>[], budget: number): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = [];
  const used = { chars: 0 };
  for (const row of rows) {
    const chars = JSON.stringify(row).length + 1;
    if (used.chars + chars > budget) break;
    kept.push(row);
    used.chars += chars;
  }
  return kept;
}

function listUsersTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('list_users', 'settings', toolSpec(
    'list_users',
    'Administrators: every user of the workspace (username, email, name, role groups, status, enabled, created). '
      + 'Read it before proposing create_user, update_user or set_user_access — identify people by email and use '
      + 'the username it lists; never guess one.',
    {},
  ), async (input, ctx) => {
    requireAdmin(ctx, 'list_users');
    parseToolInput(noInput, input);
    const rows = await readUsers(deps, ctx);
    const projected = rows.slice(0, MAX_LISTED_USERS).map((row) => pick(row, USER_FIELDS, MAX_USER_STRING));
    const users = fittingPrefix(projected, USERS_RESULT_BUDGET);
    const truncated = users.length < rows.length ? { truncated: true } : {};
    return { content: jsonResult({ count: rows.length, users, ...truncated }, USERS_RESULT_BUDGET + ENVELOPE_CHARS) };
  });
}

function getUserAccessTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('get_user_access', 'settings', toolSpec(
    'get_user_access',
    'Administrators: which categories and sources one user may see. `all` true = every category; `sources` is '
      + '["*"] (every source), a list of source ids, or null (the default: every source that is not restricted). '
      + 'Administrators always see everything, whatever this says. Read before proposing set_user_access.',
    { username: { type: 'string', maxLength: USER_LIMITS.maxUsernameLength, description: 'Cognito username from list_users.' } },
    ['username'],
  ), async (input, ctx) => {
    requireAdmin(ctx, 'get_user_access');
    const { username } = parseToolInput(usernameInput, input);
    const body = await deps.invoke({
      fn: 'users',
      method: 'GET',
      path: `/users/${seg(username)}/category-access`,
      resource: '/users/{proxy+}',
      pathParameters: { proxy: `${username}/category-access` },
    }, ctx.claims);
    return { content: jsonResult({ username, ...accessBodySchema.parse(isRecord(body) ? body : {}) }) };
  });
}

export function createUserServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [listUsersTool(deps), getUserAccessTool(deps)];
}
