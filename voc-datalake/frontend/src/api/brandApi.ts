/**
 * @fileoverview The brand's wire shapes, and the deployment's own brand: `GET` and `PUT /settings/brand` WITHOUT
 * `X-Workspace-Id` (lambda/api/settings_handler.py; docs/multi-workspace.md → Per-workspace configuration).
 *
 * A request that names no workspace reads and writes the deployment-wide row `SETTINGS#brand`, as before
 * workspaces; its save is for the deployment's `admins` (`require_settings_admin`, lambda/shared/request_workspace.py).
 * Inside a workspace every other call names the workspace, so these two opt out explicitly (`'deployment'`,
 * api/baseUrl.ts `RequestScope`): the platform console's editor of the deployment default reaches the
 * deployment's row from any address, a workspace's included. The answer is read leniently: a field of the wrong
 * type reads as empty.
 *
 * The same row holds the workspace's FORM brand (7.55.01, `form_theme`: the forms builder's "Your brand" preset, the
 * theme a new form starts on; null when none was saved). `formBrandApi.save` PUTs only it, in the current workspace,
 * which the server applies alone (the brand's own fields stay); a full brand save keeps it.
 *
 * @module api/brandApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { put } from './requestKit'
import type { FormTheme } from '../pages/FeedbackForms/model/formsV2'
import { themeSchema } from '../pages/FeedbackForms/model/formsV2Schema'

/** Brand settings payload returned by GET /settings/brand. */
export interface BrandSettingsResponse {
  brand_name?: string
  brand_handles?: string[]
  hashtags?: string[]
  urls_to_track?: string[]
  /** The workspace's form brand (a form theme), null when none was saved. */
  form_theme?: unknown
  error?: string
}

/** The body of `PUT /settings/brand`. */
export interface BrandSettingsPayload {
  brand_name: string
  brand_handles: string[]
  hashtags: string[]
  urls_to_track: string[]
}

const strings = z.array(z.string()).catch([])
const BrandSchema = z.object({
  brand_name: z.string().catch(''),
  brand_handles: strings,
  hashtags: strings,
  urls_to_track: strings,
})

/** The stored brand, every field present; an answer that is not an object reads as an empty brand. */
export function readBrand(raw: unknown): BrandSettingsPayload {
  const parsed = BrandSchema.safeParse(raw)
  return parsed.success ? parsed.data : { brand_name: '', brand_handles: [], hashtags: [], urls_to_track: [] }
}

/** The deployment's brand: under the brand's root, so a save of either brand refreshes both. */
export const deploymentBrandKey = () => ['brand-settings', 'deployment'] as const

export const deploymentBrandApi = {
  get: async (): Promise<BrandSettingsPayload> => readBrand(await fetchApi<unknown>('/settings/brand', { method: 'GET' }, 'deployment')),
  /** The deployment's `admins` only (403 for anyone else). */
  save: (settings: BrandSettingsPayload) => fetchApi<unknown>('/settings/brand', put(settings), 'deployment'),
}

/** The form brand of a `GET /settings/brand` answer, every field read with its default; null when none was saved. */
export function readFormBrand(raw: unknown): FormTheme | null {
  if (typeof raw !== 'object' || raw === null || !('form_theme' in raw)) return null
  const stored = raw.form_theme
  return typeof stored === 'object' && stored !== null ? themeSchema.parse(stored) : null
}

/** The current workspace's form brand (its admins only: 403 for anyone else). */
export const formBrandApi = {
  /** Save `theme` as the form brand (null removes it); the brand's own fields stay as they are. */
  save: (theme: FormTheme | null) => fetchApi<unknown>('/settings/brand', put({ form_theme: theme })),
}
