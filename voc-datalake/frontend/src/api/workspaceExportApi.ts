/**
 * @fileoverview The current workspace's export (`/me/workspaces/current/export`; lambda/api/workspaces_handler.py,
 * lambda/shared/export_jobs.py, docs/multi-workspace.md → Export and delete).
 *
 * For the workspace's admins only: start an export (202, the job runs in the background), read the newest export's
 * status, and ask for a fresh 15-minute download link of a completed one (each link audited). A completed export can
 * be downloaded for 7 days. Every call names the workspace in `X-Workspace-Id` (api/baseUrl.ts). The status is read
 * leniently: an answer this build cannot read is no export.
 *
 * @module api/workspaceExportApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { post } from './requestKit'

/** The statuses the server answers (shared/export_jobs.py `job_view`): an unknown one reads as failed. */
const STATUSES = ['queued', 'running', 'completed', 'failed', 'expired', 'erased'] as const
export type ExportStatus = (typeof STATUSES)[number]

const ExportSchema = z.object({
  id: z.string().min(1),
  status: z.enum(STATUSES).catch('failed'),
  created_at: z.string().catch(''),
  completed_at: z.string().optional().catch(undefined),
  expires_at: z.string().optional().catch(undefined),
  size_bytes: z.number().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
})
export type WorkspaceExport = z.infer<typeof ExportSchema>

const StatusSchema = z.object({ export: z.unknown() })
const StartedSchema = z.object({ export: ExportSchema })
const LinkSchema = z.object({ link: z.object({ id: z.string(), url: z.url(), expires_in: z.number() }) })
export type ExportLink = z.infer<typeof LinkSchema>['link']

/** The newest export of a `GET /me/workspaces/current/export` answer, or null (none yet, or unreadable). */
export function readWorkspaceExport(raw: unknown): WorkspaceExport | null {
  const parsed = StatusSchema.safeParse(raw)
  if (!parsed.success || parsed.data.export === null) return null
  const found = ExportSchema.safeParse(parsed.data.export)
  return found.success ? found.data : null
}

/** Whether the export is still being made: the status is polled only then. */
export function isExportRunning(status: ExportStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** One workspace's export status, under the caller's workspaces' root. */
export const workspaceExportKey = (workspaceId: string) => ['my-workspaces', 'export', workspaceId] as const

// Each path is written out in full, so the route audit (scripts/audit/py_route_callers.py) reads it as the caller.
export const workspaceExportApi = {
  status: async (): Promise<WorkspaceExport | null> => readWorkspaceExport(await fetchApi<unknown>('/me/workspaces/current/export')),
  /** Its refusals are workspaceRefusals.ts `EXPORT_REFUSALS`. */
  start: async (): Promise<WorkspaceExport> =>
    StartedSchema.parse(await fetchApi<unknown>('/me/workspaces/current/export', post({}))).export,
  /** A fresh 15-minute link of the newest completed export (409 once it is not downloadable). */
  link: async (): Promise<ExportLink> =>
    LinkSchema.parse(await fetchApi<unknown>('/me/workspaces/current/export/link', post({}))).link,
}
