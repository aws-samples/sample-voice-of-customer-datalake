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
 * Each session write inside the workspace then asks again whether it is still active
 * (`createWorkspaceStatusCheck`, called by the store's put).
 * IAM: GetItem on the `WS#*` partitions of voc-workspaces only, held to pk, sk, role and status
 * (lib/utils/workspace-resolution-grants.ts `grantWorkspaceRoleAndStatusReads`).
 */
import { ApiError } from '../../lib/errors.js';
import { parseGroups } from '../runtime/event.js';
import type { CallerClaims } from '../types.js';
import { readWorkspaceRow, readWorkspaceStatus, type StatusDocClient } from './workspace-status.js';

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

/** What the membership needs of a document client: the status read's own (one GetItem). */
export type MembershipDocClient = StatusDocClient;

/**
 * What the membership read names (LOCKSTEP with lambda/shared/workspace.py `MEMBER_READ_ATTRIBUTES` and
 * lib/utils/workspace-resolution-grants.ts `ROLE_AND_STATUS_ATTRIBUTES`; never a member's email). The `META` read is
 * workspace-status.ts `readWorkspaceStatus`'s. The role's GetItem is held to pk, sk, role and status and refuses a read
 * that names none (`grantWorkspaceRoleAndStatusReads`), so every read sends its projection.
 */
const MEMBER_ROW_ATTRIBUTES = ['pk', 'sk', 'role'] as const;

export function createWorkspaceMembership(client: MembershipDocClient, tableName: string): WorkspaceMembership {
  return {
    async isMember(workspace, sub) {
      const { role: stored } = await readWorkspaceRow(client, tableName, { pk: `WS#${workspace}`, sk: `MEMBER#${sub}` },
        MEMBER_ROW_ATTRIBUTES);
      if (typeof stored !== 'string' || !ROLES.has(stored)) return false;
      // Fresh, uncached: a run that starts after the workspace is marked `deleting` saves nothing.
      return await readWorkspaceStatus(client, tableName, workspace) === 'active';
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
