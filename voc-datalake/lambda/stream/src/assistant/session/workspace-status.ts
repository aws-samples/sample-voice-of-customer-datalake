/**
 * Whether a workspace is still `active`: the one reader of its `META` status in this Lambda
 * ({@link readWorkspaceStatus}, uncached), used fresh at a run's start (workspace-member.ts) and, through
 * {@link createWorkspaceStatusCheck}'s short cache, before every session write inside the workspace (store.ts `put`):
 * before the owner is listed among its conversation owners (`WS#{ws}#CONVERSANTS`) and before the conversation row.
 *
 * Why: a workspace's hard delete marks its `META` `deleting`, waits out a fence, then sweeps its conversations by
 * walking that owner list (docs/multi-workspace.md, "Export and delete"). A row written after the sweep could land in
 * a partition it never finds. The bound the fence rests on is the run's own timeout, not this cache: every run reads
 * the status fresh at its start, so a run that starts after the mark writes nothing, and the handler awaits every save
 * before it returns, so a run that started before the mark writes its last row within one invocation of it
 * (`CHAT_STREAM_TIMEOUT`, 15 minutes, lib/stacks/api-assistant-lambdas.ts; pinned by a CDK test). The cache never
 * extends that bound past the run's end; the per-write check only stops such a run sooner, at its first write after
 * its cached `active` answer expires. The delete's fence must be above this bound plus the chat API's timeout and a
 * margin (docs/multi-workspace.md, "Export and delete", step 4).
 *
 * The rules, the same as the API's (lambda/shared/workspace.py: a `deleting` workspace answers the one 404):
 * - one strongly consistent GetItem of `WS#{ws}` / `META`, projected to {@link STATUS_READ_ATTRIBUTES} (the role's
 *   attribute-limited read of voc-workspaces, lib/utils/workspace-resolution-grants.ts
 *   `grantWorkspaceRoleAndStatusReads`);
 * - a missing `META`, or any status but `active`, is not active (the store then writes nothing);
 * - a failed read throws its own error: nothing is sent, nothing is kept, and the next write reads again;
 * - an `active` answer is kept {@link ACTIVE_TTL_MS} (300 s), a not-active one {@link NOT_ACTIVE_TTL_MS} (30 s), per
 *   warm container, from when its read was sent: the TTLs the hard delete's planned Python status check will use (not
 *   merged yet; today the API resolves a write's workspace fresh, with no status cache). A read sent earlier that
 *   returns later never replaces a newer answer, so it can let through at most one write, inside the run bound above.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

/** How long an `active` answer is kept (as the hard delete's planned Python status check will: 300 s). */
export const ACTIVE_TTL_MS = 300_000;
/** How long a not-active answer (a `deleting` or missing workspace) is kept (as that planned check will: 30 s). */
export const NOT_ACTIVE_TTL_MS = 30_000;
/** How many workspaces a warm container remembers before it forgets them all (and reads each once more). */
const MAX_REMEMBERED = 1000;
/** What a `META` read names: a subset of lambda/shared/workspace.py `META_READ_ATTRIBUTES`, and of the role's grant
 *  (lib/utils/workspace-resolution-grants.ts `ROLE_AND_STATUS_ATTRIBUTES`, LOCKSTEP). */
export const STATUS_READ_ATTRIBUTES = ['pk', 'sk', 'status'] as const;

/** What the status read needs of a document client. */
export interface StatusDocClient {
  send(command: GetCommand): Promise<unknown>;
}

export interface WorkspaceStatusCheck {
  /** True while `workspace` is active (kept per the TTLs); false when it is not; a failed read rejects as it is. */
  isActive(workspace: string): Promise<boolean>;
}

const itemSchema = z.object({ Item: z.record(z.string(), z.unknown()).optional() }).loose();

/** One voc-workspaces row's `attributes`, read strongly consistent (the role's GetItem is held to named attributes
 *  and refuses a read that names none, so every read sends its projection); `{}` when there is no row. */
export async function readWorkspaceRow(client: StatusDocClient, tableName: string, key: { pk: string; sk: string },
  attributes: readonly string[]): Promise<Record<string, unknown>> {
  // Every attribute through a name placeholder (`role` and `status` are reserved words).
  const names = Object.fromEntries(attributes.map((attribute, index) => [`#a${String(index)}`, attribute]));
  const response = await client.send(new GetCommand({
    TableName: tableName, Key: key, ConsistentRead: true,
    ProjectionExpression: Object.keys(names).join(', '), ExpressionAttributeNames: names,
  }));
  const parsed = itemSchema.safeParse(response);
  return parsed.success ? parsed.data.Item ?? {} : {};
}

/** `workspace`'s `META` status, read strongly consistent and uncached; undefined when there is no `META` (or no
 *  status). A failed read rejects. */
export async function readWorkspaceStatus(client: StatusDocClient, tableName: string, workspace: string): Promise<unknown> {
  const meta = await readWorkspaceRow(client, tableName, { pk: `WS#${workspace}`, sk: 'META' }, STATUS_READ_ATTRIBUTES);
  return meta.status;
}

export function createWorkspaceStatusCheck(
  client: StatusDocClient, tableName: string, nowMs: () => number = () => Date.now(),
): WorkspaceStatusCheck {
  const remembered = new Map<string, { active: boolean; asked: number }>();
  const ttl = (active: boolean) => (active ? ACTIVE_TTL_MS : NOT_ACTIVE_TTL_MS);

  return {
    async isActive(workspace) {
      const asked = nowMs();
      const kept = remembered.get(workspace);
      if (kept !== undefined && asked < kept.asked + ttl(kept.active)) return kept.active;
      const active = await readWorkspaceStatus(client, tableName, workspace) === 'active';
      // Kept from when its read was sent, so an answer is never older than its TTL when used; a read sent earlier
      // that returns later than another never replaces the newer answer (its own caller still gets its answer).
      const newest = remembered.get(workspace);
      if (newest === undefined || newest.asked < asked) {
        if (remembered.size >= MAX_REMEMBERED) remembered.clear();
        remembered.set(workspace, { active, asked });
      }
      return active;
    },
  };
}
