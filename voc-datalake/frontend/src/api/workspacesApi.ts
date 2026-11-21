/**
 * @fileoverview The caller's workspaces (`GET /me/workspaces`, `GET /me/workspaces/current`), and the rename of the
 * current one (`PUT /me/workspaces/current`; lambda/api/workspaces_handler.py, docs/multi-workspace.md).
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
import { put } from './requestKit'
import { isWorkspaceSlug } from '../workspace/workspacePath'
import type { CurrentWorkspace } from '../workspace/currentWorkspace'
import { PLAYBOOK_ROLES } from './onboardingApi'
import type { PlaybookRole } from './onboardingApi'

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

/**
 * What every member reads of a trial workspace (7.71.00; `trial_summary` in lambda/shared/trial_state.py), from
 * `GET /me/workspaces/current` and, as the listing row's copy, `GET /platform/workspaces`: when it ends, whether and
 * since when it is paused (and how many plugins and live forms the pause turned off), whether it was converted.
 * Read leniently: a field this build cannot read is null.
 */
export const TrialSummarySchema = z.object({
  days: z.number().int().positive().catch(30),
  expires_at: z.string().nullable().catch(null),
  paused_at: z.string().nullable().catch(null),
  converted_at: z.string().nullable().catch(null),
  paused: z.object({ plugins: z.number().int().nonnegative(), forms: z.number().int().nonnegative() }).nullable().catch(null),
})
export type TrialSummary = z.infer<typeof TrialSummarySchema>

/** `GET /me/workspaces/current`: the workspace as the server resolves it, its trial (or none) and the role playbook
 *  suggested to the caller when they were added (or none). */
const ServerWorkspaceSchema = WorkspaceSchema.extend({
  trial: TrialSummarySchema.nullable().catch(null),
  playbook: z.enum(PLAYBOOK_ROLES).nullable().catch(null),
})
export interface ServerWorkspace extends CurrentWorkspace {
  readonly trial: TrialSummary | null
  readonly playbook: PlaybookRole | null
}

const ListSchema = z.object({ workspaces: z.array(z.unknown()) })
const CurrentSchema = z.object({ workspace: ServerWorkspaceSchema })

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
  current: async (): Promise<ServerWorkspace> => CurrentSchema.parse(await fetchApi<unknown>('/me/workspaces/current')).workspace,
  /**
   * Rename the current workspace (its admins; the slug, so its address, stays): the workspace as `current` answers
   * it. Its refusals are workspaceRefusals.ts `RENAME_REFUSALS`.
   */
  rename: async (name: string): Promise<ServerWorkspace> =>
    CurrentSchema.parse(await fetchApi<unknown>('/me/workspaces/current', put({ name }))).workspace,
}
