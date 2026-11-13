/**
 * Whose conversation a run saves (docs/multi-workspace.md, "Request flow": the assistant's conversations): the verified caller's own, inside the
 * workspace the request names when it names one and the caller is a member of it.
 *
 * The request's `X-Workspace-Id` (claims `voc:workspace`, runtime/event.ts) is judged HERE before any session row is
 * read or written, as lambda/shared/workspace.py judges it for a member (LOCKSTEP; no platform admin's entry, as
 * api/chat_handler.py resolves with `elevate=False`, the other writer of these rows):
 * - no header, or a blank one: the caller's own partition outside any workspace, as before;
 * - a malformed id, a service subject (`mcp:` / `agent:`), no `MEMBER#{sub}` row with a known role, or a workspace
 *   whose `META` status is not `active`: the one 404, `Workspace not found`, whatever the reason;
 * - a member: `WS#{ws}#USER#{sub}` (record.ts `callerPartition`);
 * - a non-member whose token is in the `platform-admins` group: no owner, so the run answers but saves nothing (no
 *   session row read or written, no Stop watch). Decision 2 lets a platform admin into any workspace, and each domain
 *   API the run reads through checks that live (shared/platform_admin.py); the token's group alone is never enough
 *   to save in a workspace, so their conversations there are kept only once they add themselves as a member.
 * Read fresh (strongly consistent, no cache) once per run, at its start, as api/chat_handler.py reads it fresh for each
 * write: a removed member starts no run that saves there.
 * IAM: GetItem on the `WS#*` partitions of voc-workspaces only (lib/utils/workspace-resolution-grants.ts).
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { parseGroups } from '../runtime/event.js';
import type { CallerClaims } from '../types.js';

/** LOCKSTEP with lambda/shared/workspace.py `NOT_FOUND`. */
export const WORKSPACE_NOT_FOUND = 'Workspace not found';
/** LOCKSTEP with lambda/shared/workspace_ids.py `_WORKSPACE_ID`: `ws_` + a ULID. */
const WORKSPACE_ID = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** LOCKSTEP with lambda/shared/workspace.py `ROLES`. */
const ROLES: ReadonlySet<string> = new Set(['viewer', 'editor', 'admin']);
/** LOCKSTEP with lambda/shared/platform_admin.py `PLATFORM_ADMIN_GROUP`. */
const PLATFORM_ADMIN_GROUP = 'platform-admins';
/** LOCKSTEP with lambda/shared/project_access.py `SYNTHETIC_SUBJECT_PREFIXES`. */
const SERVICE_SUBJECT_PREFIXES = ['mcp:', 'agent:'];

/** A request naming a workspace the caller may not save in: the one answer, never which reason. */
export class WorkspaceNotFoundError extends ApiError {
  constructor() {
    super(WORKSPACE_NOT_FOUND, 404);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** Whose conversations a run reaches: the verified caller, inside a workspace they are a member of (or none). */
export interface SessionOwner {
  readonly sub: string;
  readonly workspace?: string;
}

export interface WorkspaceMembership {
  isMember(workspace: string, sub: string): Promise<boolean>;
}

/** What the membership needs of a document client. */
export interface MembershipDocClient {
  send(command: GetCommand): Promise<unknown>;
}

const rowSchema = z.object({ Item: z.object({ role: z.unknown().optional(), status: z.unknown().optional() }).loose().optional() }).loose();

export function createWorkspaceMembership(client: MembershipDocClient, tableName: string): WorkspaceMembership {
  async function row(pk: string, sk: string): Promise<{ role?: unknown; status?: unknown }> {
    const response = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }));
    const parsed = rowSchema.safeParse(response);
    return parsed.success ? parsed.data.Item ?? {} : {};
  }
  return {
    async isMember(workspace, sub) {
      const { role } = await row(`WS#${workspace}`, `MEMBER#${sub}`);
      if (typeof role !== 'string' || !ROLES.has(role)) return false;
      const { status } = await row(`WS#${workspace}`, 'META');
      return status === 'active';
    },
  };
}

/**
 * The run's session owner (see the module docstring): undefined for an entered platform admin who is not a member
 * (the run saves nothing); `WorkspaceNotFoundError` for any other caller the workspace is not theirs, and also when
 * the request names one but this deployment has no membership table to check it against.
 */
export async function resolveSessionOwner(membership: WorkspaceMembership | undefined,
  claims: Pick<CallerClaims, 'sub' | 'voc:workspace' | 'cognito:groups'>): Promise<SessionOwner | undefined> {
  const named = claims['voc:workspace']?.trim() ?? '';
  if (named === '') return { sub: claims.sub };
  if (!WORKSPACE_ID.test(named) || SERVICE_SUBJECT_PREFIXES.some((prefix) => claims.sub.startsWith(prefix))
    || membership === undefined) {
    throw new WorkspaceNotFoundError();
  }
  if (await membership.isMember(named, claims.sub)) return { sub: claims.sub, workspace: named };
  if (parseGroups(claims['cognito:groups']).includes(PLATFORM_ADMIN_GROUP)) return undefined;
  throw new WorkspaceNotFoundError();
}
