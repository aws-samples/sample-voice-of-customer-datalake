/**
 * @fileoverview The members of the current workspace (`/me/workspaces/current/members`;
 * lambda/api/workspaces_handler.py, lambda/shared/workspace_members.py, docs/multi-workspace.md → Invites).
 *
 * Every call names the workspace in `X-Workspace-Id`, which the client adds inside a workspace (api/baseUrl.ts);
 * the server resolves the caller's role there itself. Any member lists; only a workspace admin adds, changes a
 * role or removes another member; any member may remove themselves (leave). The list is read leniently: a row this
 * build cannot read is left out, as the server leaves out a row with an unknown role.
 *
 * @module api/workspaceMembersApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { cursorQuery, del, post, put } from './requestKit'
import { readCursorPage } from './cursorPage'
import type { CursorPage } from './cursorPage'
import { RoleSchema } from './workspacesApi'
import type { WorkspaceRole } from './workspacesApi'

const MemberSchema = z.object({
  sub: z.string().min(1),
  role: RoleSchema,
  // Empty when the row holds none and Cognito could not fill it (an erased address, a deleted account).
  email: z.string().catch(''),
  name: z.string().catch(''),
  joined_at: z.string().catch(''),
})
export type WorkspaceMember = z.infer<typeof MemberSchema>

/** `account` of an add: the email had an account already, or the add created one (temporary password emailed). */
const AddedSchema = z.object({
  member: MemberSchema.extend({ account: z.enum(['existing', 'created']) }),
})
export type AddedMember = z.infer<typeof AddedSchema>['member']

/**
 * One workspace's member list (all its pages), under the caller's workspaces' root (so a write's refresh of that root
 * reads it again), in the `standard` family (a sub-key in api/queryPolicies.ts: other admins change it).
 */
export const workspaceMembersKey = (workspaceId: string) => ['my-workspaces', 'members', workspaceId] as const

// Each path is written out in full, so the route audit (scripts/audit/py_route_callers.py) reads it as the caller.
export const workspaceMembersApi = {
  /** One page of members (25, the server's default), from `cursor` when given. */
  // The rows this build can read, in the server's order (by sub).
  list: async (cursor: string | null): Promise<CursorPage<WorkspaceMember>> => readCursorPage(await (cursor === null
    ? fetchApi<unknown>('/me/workspaces/current/members')
    : fetchApi<unknown>(`/me/workspaces/current/members?${cursorQuery(cursor)}`)), 'members', MemberSchema),
  /** Workspace admins only: an email with an account becomes a member at once; a new one gets an account first. */
  add: async (email: string, role: WorkspaceRole): Promise<AddedMember> =>
    AddedSchema.parse(await fetchApi<unknown>('/me/workspaces/current/members', post({ email, role }))).member,
  /** Workspace admins only. */
  changeRole: (sub: string, role: WorkspaceRole) =>
    fetchApi<unknown>(`/me/workspaces/current/members/${encodeURIComponent(sub)}`, put({ role })),
  /** Workspace admins, or the member themselves (leave). */
  remove: (sub: string) => fetchApi<unknown>(`/me/workspaces/current/members/${encodeURIComponent(sub)}`, del()),
}
