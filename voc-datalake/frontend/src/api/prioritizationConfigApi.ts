/**
 * @fileoverview The workspace SCORING SETUP routes: read it (any signed-in user) and
 * replace it (admins only), with optimistic concurrency on `config_version`.
 *
 * `GET /projects/prioritization/config` → `{axes, config_version, updated_at, updated_by}`;
 * `PUT` the same path with `{axes: AxisInput[], base_version}` → the stored setup (not decoded:
 * callers re-read), 400 with a client-safe reason for an invalid setup, 403 for a non-admin,
 * 409 when somebody saved since `base_version` was read. See docs/prioritization.md.
 *
 * @module api/prioritizationConfigApi
 */
import { put } from './requestKit'
import { z } from 'zod'
import { ApiError, serverReason } from '../lib/errors'
import { fetchApi } from './client'
import { configVersionOf, normalizeAxes } from './prioritizationAxes'
import type { AxisDirection, ScoringAxis } from './prioritizationAxes'

const CONFIG_PATH = '/projects/prioritization/config'

/** Query key of the setup read, shared by the editor, the read-only view and the page. */
export const SCORING_CONFIG_KEY = ['prioritization-config'] as const

/** The setup as the editor and the read-only view show it. */
export interface PrioritizationConfig {
  readonly axes: readonly ScoringAxis[]
  readonly configVersion: number
  /** ISO timestamp of the last save, `null` while nothing is stored. */
  readonly updatedAt: string | null
  /** Who saved it last (a display name), `null` while nothing is stored. */
  readonly updatedBy: string | null
}

/**
 * One metric as a save SENDS it: the wire axis without `builtin` (the server decides
 * that), and without `id` for a NEW metric — the server mints a slug from its label.
 */
export interface AxisInput {
  readonly id?: string
  readonly label: string | null
  readonly description: string | null
  readonly weight: number
  readonly direction: AxisDirection
  readonly low_label: string | null
  readonly high_label: string | null
  readonly archived: boolean
}

export type SaveConfigResult =
  | { readonly ok: true }
  /** 409: somebody else saved since this setup was read. */
  | { readonly ok: false; readonly kind: 'conflict' }
  /** 400: the server refused the setup; `message` is its client-safe reason. */
  | { readonly ok: false; readonly kind: 'invalid'; readonly message: string | null }
  /** Anything else (403, 5xx, network). */
  | { readonly ok: false; readonly kind: 'failed'; readonly message: string | null }

const optionalString = z.string().min(1).nullable().catch(null)

/** Lenient: the axes go through `normalizeAxes`, so an unreadable list reads as the default. */
const ConfigSchema = z.object({
  axes: z.unknown().optional(),
  config_version: z.unknown().optional(),
  updated_at: optionalString.optional().transform((value) => value ?? null),
  updated_by: optionalString.optional().transform((value) => value ?? null),
})

function normalizeConfig(raw: unknown): PrioritizationConfig | null {
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    axes: normalizeAxes(parsed.data.axes),
    configVersion: configVersionOf(parsed.data.config_version),
    updatedAt: parsed.data.updated_at,
    updatedBy: parsed.data.updated_by,
  }
}

/** The response may wrap the setup (`{config: …}`) or be the setup itself. */
function configOfResponse(raw: unknown): PrioritizationConfig | null {
  const wrapped = z.object({ config: z.unknown() }).safeParse(raw)
  return normalizeConfig(wrapped.success ? wrapped.data.config : raw)
}

function refusalOf(error: unknown): SaveConfigResult {
  if (!(error instanceof ApiError)) return { ok: false, kind: 'failed', message: null }
  if (error.status === 409) return { ok: false, kind: 'conflict' }
  if (error.status === 400) return { ok: false, kind: 'invalid', message: serverReason(error) }
  return { ok: false, kind: 'failed', message: serverReason(error) }
}

export const prioritizationConfigApi = {
  /** The current setup. An unreadable body reads as the default at version 0. */
  getConfig: async (): Promise<PrioritizationConfig> => {
    const raw = await fetchApi<unknown>(CONFIG_PATH)
    return configOfResponse(raw) ?? { axes: normalizeAxes(undefined), configVersion: 0, updatedAt: null, updatedBy: null }
  },

  /**
   * Replace the setup. Returns a RESULT rather than throwing for the refusals the editor
   * has words for (409, 400). The 2xx body is not decoded: callers re-read the setup.
   */
  saveConfig: async (axes: readonly AxisInput[], baseVersion: number): Promise<SaveConfigResult> => {
    try {
      await fetchApi<unknown>(CONFIG_PATH, put({ axes, base_version: baseVersion }))
      return { ok: true }
    } catch (error: unknown) {
      return refusalOf(error)
    }
  },
}
