/**
 * @fileoverview The platform console's workspaces (`GET` and `POST /platform/workspaces`; platform admins only,
 * lambda/api/workspaces_handler.py, lambda/shared/platform_workspaces.py, docs/multi-workspace.md → Control plane).
 *
 * The list holds every workspace of the deployment by name, a page at a time; a row this build cannot read is left
 * out. Creating one makes the caller its admin. A trial workspace (7.71.00, docs/multi-workspace.md "Trial
 * workspaces") is created the same way with `trial: {days, pack}`, and extended (14, 30 or 60 more days) or converted
 * into a regular workspace with `POST /platform/workspaces/{id}/trial/extend` and `…/convert`; it never deletes itself. The answers still carry `secret_status` (always `ready` since decision
 * 19, docs/multi-workspace.md → Credentials: a workspace's credentials need no secret); the console reads nothing of it.
 *
 * @module api/platformWorkspacesApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { post } from './requestKit'
import { TrialSummarySchema, WorkspaceIdentitySchema } from './workspacesApi'
import { readCursorPage } from './cursorPage'
import type { CursorPage } from './cursorPage'

/** `NAME_MAX_CHARS` in lambda/shared/platform_workspaces.py. */
export const WORKSPACE_NAME_MAX = 80

// A slug that could not be a base path could never be entered, so it is not listed.
const PlatformWorkspaceSchema = WorkspaceIdentitySchema.extend({
  status: z.string().catch(''),
  created_at: z.string().catch(''),
  trial: TrialSummarySchema.nullable().catch(null),
})
export type PlatformWorkspace = z.infer<typeof PlatformWorkspaceSchema>

const CreatedSchema = z.object({
  workspace: PlatformWorkspaceSchema.pick({ id: true, name: true, slug: true }),
})
export type CreatedWorkspace = z.infer<typeof CreatedSchema>['workspace']

/** A trial's length in days (`TRIAL_DAYS` in lambda/shared/trial_state.py), and its default. */
export const TRIAL_DAYS = [14, 30, 60] as const
export type TrialDays = typeof TRIAL_DAYS[number]
export const DEFAULT_TRIAL_DAYS: TrialDays = 30

/** `value` as a trial length (a select's value), or the default for anything else. */
export function toTrialDays(value: unknown): TrialDays {
  return TRIAL_DAYS.find((days) => days === Number(value)) ?? DEFAULT_TRIAL_DAYS
}

/** What the starter pack asked for, recorded on the trial (the creates themselves go through their own routes). */
interface TrialPackRequest {
  readonly forms: readonly string[]
  readonly categories: boolean
  readonly playbooks: boolean
}

/** What an extension or a conversion turned back on (`resume`, lambda/shared/trial_pause.py): how many plugins and
 * forms, and each form it left off with the publish rule's code (`theme_unreadable`, `unresolved_placeholder`, …). */
const TrialResumedSchema = z.object({
  plugins: z.number().catch(0),
  forms: z.number().catch(0),
  skipped: z.array(z.object({ form_id: z.string(), name: z.string().catch(''), code: z.string().catch('') })).catch([]),
})
export type TrialResumed = z.infer<typeof TrialResumedSchema>

/** The platform console's view of a trial (`trial_view`, lambda/shared/trials.py): its end and its history, and what
 * the extension or conversion that answered it resumed (`resumed`, null when the trial was not paused). */
const TrialViewSchema = z.object({
  days: z.number().catch(30),
  expires_at: z.string().nullable().catch(null),
  paused_at: z.string().nullable().catch(null),
  converted_at: z.string().nullable().catch(null),
  extended: z.array(z.unknown()).catch([]),
  resumed: TrialResumedSchema.nullable().catch(null),
})
type TrialView = z.infer<typeof TrialViewSchema>
const TrialAnswerSchema = z.object({ trial: TrialViewSchema })

/** Every workspace of the deployment (all pages read so far). */
export const platformWorkspacesKey = () => ['platform-workspaces'] as const

export const platformWorkspacesApi = {
  /** One page (25, the server's default, or `limit`: 1 to 100), from `cursor` when given. */
  // The rows this build can read, in the server's order (by name).
  list: async (cursor: string | null, limit?: number): Promise<CursorPage<PlatformWorkspace>> => {
    const query = new URLSearchParams(cursor === null ? {} : { cursor })
    if (limit !== undefined) query.set('limit', String(limit))
    const asked = query.toString()
    return readCursorPage(await fetchApi<unknown>(asked === '' ? '/platform/workspaces' : `/platform/workspaces?${asked}`),
      'workspaces', PlatformWorkspaceSchema)
  },
  /** 409 when the slug is taken (nothing written). */
  create: async (name: string, slug: string): Promise<CreatedWorkspace> =>
    CreatedSchema.parse(await fetchApi<unknown>('/platform/workspaces', post({ name, slug }))).workspace,
  /** A trial workspace of `days` days, the caller its admin (voc-trial-expiry's hourly tick pauses it after its end). */
  createTrial: async (name: string, slug: string, days: TrialDays, pack: TrialPackRequest): Promise<CreatedWorkspace> =>
    CreatedSchema.parse(await fetchApi<unknown>('/platform/workspaces', post({ name, slug, trial: { days, pack } }))).workspace,
  /** `days` more from its end (or from now once it ended); a paused trial's plugins and forms are turned back on. */
  extendTrial: async (workspaceId: string, days: TrialDays): Promise<TrialView> =>
    TrialAnswerSchema.parse(await fetchApi<unknown>(`/platform/workspaces/${encodeURIComponent(workspaceId)}/trial/extend`,
      post({ days }))).trial,
  /** A regular workspace from now on (no end); a paused trial is resumed first. */
  convertTrial: async (workspaceId: string): Promise<TrialView> =>
    TrialAnswerSchema.parse(await fetchApi<unknown>(`/platform/workspaces/${encodeURIComponent(workspaceId)}/trial/convert`,
      post({}))).trial,
}
