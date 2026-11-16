/**
 * @fileoverview Wire boundary for the web search surface's parts of `GET /settings/model` (7.42.00,
 * lambda/api/settings_handler.py): `web_search_models`, the OpenAI GPT models that only `web_reviews_search` may
 * pick, and each surface's `allowlist`, the list it picks from (`claude` = `available_models`, `web_search` =
 * `web_search_models`).
 *
 * Lenient: an older API sends neither, so the list reads as empty and every surface as `claude`; a malformed row
 * costs only itself.
 *
 * @module api/modelSettingsSchema
 */
import { z } from 'zod'
import { parseEach } from './lenientFields'

const ModelRowSchema = z.object({
  key: z.string(),
  id: z.string(),
  label: z.string(),
  description: z.string().catch(''),
})

export type ModelRow = z.infer<typeof ModelRowSchema>

/** The list a surface picks from. */
export type SurfaceAllowlist = 'claude' | 'web_search'

/** The valid rows of `web_search_models`; anything else is an empty list. */
export function normalizeWebSearchModels(raw: unknown): ModelRow[] {
  return parseEach(ModelRowSchema, raw)
}

/** A surface's `allowlist`: `web_search` when it says so, else `claude` (absent on an older API). */
export function readSurfaceAllowlist(raw: unknown): SurfaceAllowlist {
  return raw === 'web_search' ? 'web_search' : 'claude'
}
