/**
 * @fileoverview The caller's workspaces (`GET /me/workspaces`, `GET /me/workspaces/current`;
 * lambda/api/workspaces_handler.py, docs/multi-workspace.md).
 *
 * `/me/workspaces` lists the workspaces the caller is a member of, by name, each with the role of its
 * membership row; `/current` answers the workspace `X-Workspace-Id` names as the caller may act in it (a 404
 * for anything else, never saying whether it exists). Both are read leniently: a row this build cannot read is
 * left out, and an answer with no list reads as no workspace, so the app falls back to how it worked before
 * workspaces instead of failing.
 *
 * @module api/workspacesApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { isWorkspaceSlug } from '../workspace/workspacePath'
import type { CurrentWorkspace } from '../workspace/currentWorkspace'

/** A member's role in a workspace (`ROLES`, lambda/shared/workspace.py), in the order the role menus offer them. */
export const WORKSPACE_ROLES = ['admin', 'editor', 'viewer'] as const
export const RoleSchema = z.enum(WORKSPACE_ROLES)
export type WorkspaceRole = z.infer<typeof RoleSchema>

/** A workspace's id, name and slug, as every workspaces route answers them (the platform console's list too). */
export const WorkspaceIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // A slug that could not be a base path could never be entered, so it is not offered.
  slug: z.string().refine(isWorkspaceSlug),
})

const WorkspaceSchema = WorkspaceIdentitySchema.extend({ role: RoleSchema })

const ListSchema = z.object({ workspaces: z.array(z.unknown()) })
const CurrentSchema = z.object({ workspace: WorkspaceSchema })

/** The rows of a `GET /me/workspaces` answer this build can read, in the server's order (by name). */
export function readMyWorkspaces(raw: unknown): CurrentWorkspace[] {
  const parsed = ListSchema.safeParse(raw)
  if (!parsed.success) return []
  return parsed.data.workspaces.flatMap((row) => {
    const workspace = WorkspaceSchema.safeParse(row)
    return workspace.success ? [workspace.data] : []
  })
}

/** The caller's workspaces: a `config`-family root (api/queryPolicies.ts), fetched once per page load. */
export const myWorkspacesKey = () => ['my-workspaces'] as const

/** The current workspace as the server resolves it (the effective role): per workspace id. */
export const currentWorkspaceKey = (id: string) => ['my-workspaces', 'current', id] as const

export const workspacesApi = {
  list: async (): Promise<CurrentWorkspace[]> => readMyWorkspaces(await fetchApi<unknown>('/me/workspaces')),
  /** Sent with the current workspace's `X-Workspace-Id` (api/baseUrl.ts); rejects with the API's 404 for a non-member. */
  current: async (): Promise<CurrentWorkspace> => CurrentSchema.parse(await fetchApi<unknown>('/me/workspaces/current')).workspace,
}
