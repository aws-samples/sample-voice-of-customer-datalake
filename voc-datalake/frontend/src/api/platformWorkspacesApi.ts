/**
 * @fileoverview The platform console's workspaces (`GET` and `POST /platform/workspaces`; platform admins only,
 * lambda/api/workspaces_handler.py, lambda/shared/platform_workspaces.py, docs/multi-workspace.md → Control plane).
 *
 * The list holds every workspace of the deployment by name, a page at a time; a row this build cannot read is left
 * out. Creating one makes the caller its admin. The answers still carry `secret_status` (always `ready` since decision
 * 19, docs/multi-workspace.md → Credentials: a workspace's credentials need no secret); the console reads nothing of it.
 *
 * @module api/platformWorkspacesApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { cursorQuery, post } from './requestKit'
import { WorkspaceIdentitySchema } from './workspacesApi'
import { readCursorPage } from './cursorPage'
import type { CursorPage } from './cursorPage'

/** `NAME_MAX_CHARS` in lambda/shared/platform_workspaces.py. */
export const WORKSPACE_NAME_MAX = 80

// A slug that could not be a base path could never be entered, so it is not listed.
const PlatformWorkspaceSchema = WorkspaceIdentitySchema.extend({
  status: z.string().catch(''),
  created_at: z.string().catch(''),
})
export type PlatformWorkspace = z.infer<typeof PlatformWorkspaceSchema>

const CreatedSchema = z.object({
  workspace: PlatformWorkspaceSchema.pick({ id: true, name: true, slug: true }),
})
export type CreatedWorkspace = z.infer<typeof CreatedSchema>['workspace']

/** Every workspace of the deployment (all pages read so far). */
export const platformWorkspacesKey = () => ['platform-workspaces'] as const

export const platformWorkspacesApi = {
  /** One page (25, the server's default), from `cursor` when given. */
  // The rows this build can read, in the server's order (by name).
  list: async (cursor: string | null): Promise<CursorPage<PlatformWorkspace>> => readCursorPage(await (cursor === null
    ? fetchApi<unknown>('/platform/workspaces')
    : fetchApi<unknown>(`/platform/workspaces?${cursorQuery(cursor)}`)), 'workspaces', PlatformWorkspaceSchema),
  /** 409 when the slug is taken (nothing written). */
  create: async (name: string, slug: string): Promise<CreatedWorkspace> =>
    CreatedSchema.parse(await fetchApi<unknown>('/platform/workspaces', post({ name, slug }))).workspace,
}
