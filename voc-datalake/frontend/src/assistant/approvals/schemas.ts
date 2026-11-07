/**
 * @fileoverview Model-facing argument schemas for every CLIENT (write) tool.
 *
 * A strict mirror of the args table in the unified-assistant contract: same
 * fields, same limits, unknown keys rejected. The server validates first; this
 * is the SPA's own boundary, because the args reach the user's REST calls with
 * the user's token and nothing upstream of this file is trusted.
 *
 * `updates` objects are narrowed to the stream Lambda's allowlists: the persona,
 * product-context and feedback-form shapes and the label schemas are imported from
 * `@stream/assistant/tools/client/allowlists` (which documents each source of truth);
 * this file adds its own "at least one field" message to them.
 *
 * @module assistant/approvals/schemas
 */
import { z } from 'zod'
import { MAX_ID_LENGTH } from '@stream/assistant/contract'
import { feedbackFormUpdatesShape, personaUpdatesShape, productContextUpdatesShape } from '@stream/assistant/tools/client/allowlists'

/**
 * A server-minted identifier used as a URL path segment. The charset excludes
 * `/`, `?`, `#` and `%` so a model cannot steer a write to another route, and
 * `.` or `..` alone is refused: a browser's URL parser resolves
 * `/projects/P/documents/..` to `/projects/P/`, so a delete would hit the project.
 */
const ID_PATTERN = /^(?!\.{1,2}$)[\w.:-]+$/
export const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH).regex(ID_PATTERN, 'Invalid identifier')

const idList = z.array(idSchema).max(20)
export const nonEmpty = (max: number) => z.string().trim().min(1).max(max)
/** Optional, but non-blank when given (the stream tools' `optionalNonEmpty`, client/text-schemas.ts). */
export const optionalNonEmpty = (max: number) => nonEmpty(max).optional()

export function hasAnyKey(value: object): boolean {
  return Object.values(value).some((v) => v !== undefined)
}
const AT_LEAST_ONE = { message: 'At least one field must be provided' }

export const createProjectArgs = z.strictObject({
  name: nonEmpty(200),
  description: z.string().max(2000).optional(),
})

export const setProblemResolvedArgs = z.strictObject({
  problem_key: nonEmpty(300),
  resolved: z.boolean(),
})

/** A category / subcategory name (the snake_case id stored on reviews, contract C). */
const MAX_CATEGORY_NAME = 64

/**
 * `set_feedback_category` — `feedback_id` is a path segment (idSchema); the
 * names travel in the body. Whether the caller may see the item and the target,
 * and whether the target exists, is the route's call (400 / 404).
 */
export const setFeedbackCategoryArgs = z.strictObject({
  feedback_id: idSchema,
  category: nonEmpty(MAX_CATEGORY_NAME),
  subcategory: nonEmpty(MAX_CATEGORY_NAME).optional(),
})

export const updateDocumentArgs = z.strictObject({
  project_id: idSchema,
  document_id: idSchema,
  content: z.string().min(1).max(200_000),
  title: nonEmpty(200).optional(),
  change_summary: nonEmpty(500),
})

export const createDocumentArgs = z.strictObject({
  project_id: idSchema,
  title: nonEmpty(200),
  content: z.string().min(1).max(200_000),
})

export const deleteDocumentArgs = z.strictObject({
  project_id: idSchema,
  document_id: idSchema,
  reason: nonEmpty(500),
})

// ── Persona updates ──────────────────────────────────────────────────────────

const personaUpdatesSchema = z.strictObject(personaUpdatesShape).refine(hasAnyKey, AT_LEAST_ONE)

export const updatePersonaArgs = z.strictObject({
  project_id: idSchema,
  persona_id: idSchema,
  updates: personaUpdatesSchema,
})

export const addPersonaNoteArgs = z.strictObject({
  project_id: idSchema,
  persona_id: idSchema,
  text: nonEmpty(2000),
})

export const updateProjectArgs = z.strictObject({
  project_id: idSchema,
  name: nonEmpty(200).optional(),
  description: z.string().max(2000).optional(),
}).refine((a) => a.name !== undefined || a.description !== undefined, AT_LEAST_ONE)

// ── Product context ──────────────────────────────────────────────────────────

const productContextUpdatesSchema = z.strictObject(productContextUpdatesShape).refine(hasAnyKey, AT_LEAST_ONE)

export const updateProductContextArgs = z.strictObject({
  project_id: idSchema,
  updates: productContextUpdatesSchema,
})

// ── Background jobs ──────────────────────────────────────────────────────────

export const startResearchArgs = z.strictObject({
  project_id: idSchema,
  question: nonEmpty(2000),
  title: nonEmpty(200).optional(),
  persona_ids: idList.optional(),
  document_ids: idList.optional(),
  use_web_search: z.boolean().optional(),
})

/** Feedback sources a job reads (`source_platform` values), as the stream's `sourceListSchema`. */
const sourceList = z.array(z.string().trim().min(1).max(256)).max(20)

export const generateDocumentArgs = z.strictObject({
  project_id: idSchema,
  doc_type: z.enum(['prd', 'prfaq']),
  title: nonEmpty(200),
  feature_idea: nonEmpty(4000),
  persona_ids: idList.optional(),
  document_ids: idList.optional(),
  sources: sourceList.optional(),
})

export const generatePersonasArgs = z.strictObject({
  project_id: idSchema,
  persona_count: z.number().int().min(1).max(8),
  custom_instructions: z.string().max(2000).optional(),
  sources: sourceList.optional(),
  /** Absent or true adds next to the project's personas; false replaces them (#353). */
  keep_existing_personas: z.boolean().optional(),
})

export const mergeDocumentsArgs = z.strictObject({
  project_id: idSchema,
  output_type: z.enum(['prd', 'prfaq', 'custom']),
  title: nonEmpty(200),
  instructions: nonEmpty(4000),
  document_ids: z.array(idSchema).min(2).max(10),
  persona_ids: idList.optional(),
})

// ── Feedback forms, scrapers, settings ───────────────────────────────────────

export const feedbackFormUpdatesSchema = z.strictObject(feedbackFormUpdatesShape).refine(hasAnyKey, AT_LEAST_ONE)

export const updateFeedbackFormArgs = z.strictObject({
  form_id: idSchema,
  updates: feedbackFormUpdatesSchema,
})

export const runScraperArgs = z.strictObject({ scraper_id: idSchema })

const brandList = (itemMax: number) => z.array(z.string().trim().min(1).max(itemMax)).max(50)

export const saveBrandSettingsArgs = z.strictObject({
  brand_name: nonEmpty(200).optional(),
  brand_handles: brandList(100).optional(),
  hashtags: brandList(100).optional(),
  urls_to_track: brandList(200).optional(),
}).refine(hasAnyKey, AT_LEAST_ONE)

export type CreateProjectArgs = z.infer<typeof createProjectArgs>
export type SetProblemResolvedArgs = z.infer<typeof setProblemResolvedArgs>
export type SetFeedbackCategoryArgs = z.infer<typeof setFeedbackCategoryArgs>
export type UpdateDocumentArgs = z.infer<typeof updateDocumentArgs>
export type CreateDocumentArgs = z.infer<typeof createDocumentArgs>
export type DeleteDocumentArgs = z.infer<typeof deleteDocumentArgs>
export type UpdatePersonaArgs = z.infer<typeof updatePersonaArgs>
export type AddPersonaNoteArgs = z.infer<typeof addPersonaNoteArgs>
export type UpdateProjectArgs = z.infer<typeof updateProjectArgs>
export type UpdateProductContextArgs = z.infer<typeof updateProductContextArgs>
export type StartResearchArgs = z.infer<typeof startResearchArgs>
export type GenerateDocumentArgs = z.infer<typeof generateDocumentArgs>
export type GeneratePersonasArgs = z.infer<typeof generatePersonasArgs>
export type MergeDocumentsArgs = z.infer<typeof mergeDocumentsArgs>
export type UpdateFeedbackFormArgs = z.infer<typeof updateFeedbackFormArgs>
export type RunScraperArgs = z.infer<typeof runScraperArgs>
export type SaveBrandSettingsArgs = z.infer<typeof saveBrandSettingsArgs>
