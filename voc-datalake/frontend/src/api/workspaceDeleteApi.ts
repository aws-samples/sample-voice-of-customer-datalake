/**
 * @fileoverview The current workspace's delete (`POST /me/workspaces/current/delete`; lambda/api/workspaces_handler.py,
 * lambda/shared/workspace_deletes.py, docs/multi-workspace.md → Export and delete).
 *
 * For the workspace's admins, on a deployment that turns it on (config.json `features.workspaceDelete`; the server
 * answers 403 otherwise): the workspace's slug typed again and a reason kept for good in the audit log (a legal basis:
 * no personal data). The 202 means the workspace is `deleting` at once (every route answers its one 404, for everyone),
 * and the job deletes its data in the background once its fence (about 20 minutes) has passed. Sent with the
 * workspace's `X-Workspace-Id` (api/baseUrl.ts). The answer is read leniently: the delete has begun whatever this
 * build can read of it.
 *
 * @module api/workspaceDeleteApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { post } from './requestKit'

const DeleteSchema = z.object({
  delete: z.object({
    /** When the job begins deleting the data (the request's time plus the fence). */
    fence_at: z.string().optional().catch(undefined),
  }),
})

/** What the page says of a delete that has begun. */
export interface WorkspaceDelete {
  /** When the data begins to be deleted, or null when the answer does not say. */
  readonly fenceAt: string | null
}

/** The delete a `POST /me/workspaces/current/delete` answered (202), as far as this build can read it. */
function readWorkspaceDelete(raw: unknown): WorkspaceDelete {
  const parsed = DeleteSchema.safeParse(raw)
  return { fenceAt: parsed.success ? parsed.data.delete.fence_at ?? null : null }
}

// The path is written out in full, so the route audit (scripts/audit/py_route_callers.py) reads it as the caller.
export const workspaceDeleteApi = {
  /** Its refusals are workspaceRefusals.ts `DELETE_REFUSALS`. */
  request: async (confirmSlug: string, legalBasis: string): Promise<WorkspaceDelete> => readWorkspaceDelete(
    await fetchApi<unknown>('/me/workspaces/current/delete', post({ confirm_slug: confirmSlug, legal_basis: legalBasis }))),
}
