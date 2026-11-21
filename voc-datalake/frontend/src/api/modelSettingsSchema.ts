/**
 * @fileoverview Wire boundary for the web search surface's parts of `GET /settings/model` (7.42.00,
 * lambda/api/settings_handler.py): `web_search_models`, the OpenAI GPT models that only `web_reviews_search` may
 * pick, and each surface's `allowlist`, the list it picks from (`claude` = `available_models`, `web_search` =
 * `web_search_models`).
 *
 * Lenient: an older API sends neither, so the list reads as empty and every surface as `claude`; a malformed row
 * costs only itself.
 *
 * 7.65.00 adds `custom_models`, the deployment's own models (`-c customModels`, docs/deployment.md "Bring your own
 * model"): each names the picker surfaces it may serve, where its inference runs and its price. Lenient the same way:
 * absent on an older API (no custom model), a malformed row dropped on its own.
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

const CUSTOM_MODEL_KINDS = ['bedrock', 'imported'] as const
const CUSTOM_MODEL_SOURCES = ['model', 'profile', 'imported'] as const

const CustomModelRowSchema = ModelRowSchema.extend({
  kind: z.enum(CUSTOM_MODEL_KINDS),
  /** In-region Bedrock model, inference profile, or Custom Model Import. */
  source: z.enum(CUSTOM_MODEL_SOURCES),
  /** The picker surfaces it may serve. */
  surfaces: z.array(z.string()).catch([]),
  /** Declared (and synth-checked) EU residency. */
  eu: z.boolean().catch(false),
  /** The Regions its inference may run in; empty = any commercial AWS Region (a `global.` profile). */
  regions: z.array(z.string()).catch([]),
  capabilities: z.object({
    tools: z.boolean().catch(false),
    documents: z.boolean().catch(false),
    json: z.boolean().catch(false),
    temperature: z.boolean().catch(false),
  }),
  /** USD per million tokens. */
  price: z.object({ in: z.number().nonnegative(), out: z.number().nonnegative() }),
})

export type CustomModelRow = z.infer<typeof CustomModelRowSchema>

/** The valid rows of `custom_models`; anything else (an older API) is an empty list. */
export function normalizeCustomModels(raw: unknown): CustomModelRow[] {
  return parseEach(CustomModelRowSchema, raw)
}
