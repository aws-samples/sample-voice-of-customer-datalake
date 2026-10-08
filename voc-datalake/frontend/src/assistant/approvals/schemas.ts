/**
 * @fileoverview Model-facing argument schemas for every CLIENT (write) tool.
 *
 * A strict mirror of the args table in the unified-assistant contract: same
 * fields, same limits, unknown keys rejected. The server validates first; this
 * is the SPA's own boundary, because the args reach the user's REST calls with
 * the user's token and nothing upstream of this file is trusted.
 *
 * `updates` objects are narrowed to allowlists:
 * - persona: the `updatable_fields` of `lambda/api/projects.py::update_persona`
 *   MINUS `research_notes` (use `add_persona_note`) and `avatar_url` /
 *   `avatar_prompt` (a model must not be able to point an avatar at a URL);
 * - product context: `product_context.py` STRING_FIELDS (with their caps) plus
 *   `current_state` (LIFECYCLE_STATES);
 * - feedback form: flat, text/boolean display settings only — see
 *   {@link FEEDBACK_FORM_UPDATABLE_FIELDS}.
 *
 * @module assistant/approvals/schemas
 */
import { z } from 'zod'
import { MAX_ID_LENGTH } from '../contract'

/**
 * A server-minted identifier used as a URL path segment. The charset excludes
 * `/`, `?`, `#` and `%` so a model cannot steer a write to another route.
 */
export const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH).regex(/^[\w.:-]+$/, 'Invalid identifier')

const idList = z.array(idSchema).max(20)
export const nonEmpty = (max: number) => z.string().trim().min(1).max(max)

export function hasAnyKey(value: object): boolean {
  return Object.values(value).some((v) => v !== undefined)
}
export const AT_LEAST_ONE = { message: 'At least one field must be provided' }

/** `YYYY-MM-DD` (the stream's `isoDateSchema`). */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')

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

const text = (max = 2000) => z.string().max(max)
const textList = z.array(z.string().max(500)).max(20)

export const PERSONA_UPDATABLE_FIELDS = [
  'name', 'tagline', 'confidence', 'identity', 'goals_motivations', 'pain_points',
  'behaviors', 'context_environment', 'quotes', 'scenario',
] as const

export const personaUpdatesSchema = z.strictObject({
  name: nonEmpty(200).optional(),
  tagline: text(500).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  identity: z.strictObject({
    age_range: text(100).optional(),
    location: text(200).optional(),
    occupation: text(200).optional(),
    income_bracket: text(100).optional(),
    education: text(200).optional(),
    family_status: text(200).optional(),
    bio: text().optional(),
  }).optional(),
  goals_motivations: z.strictObject({
    primary_goal: text().optional(),
    secondary_goals: textList.optional(),
    success_definition: text().optional(),
    underlying_motivations: textList.optional(),
  }).optional(),
  pain_points: z.strictObject({
    current_challenges: textList.optional(),
    blockers: textList.optional(),
    workarounds: textList.optional(),
    emotional_impact: text().optional(),
  }).optional(),
  behaviors: z.strictObject({
    current_solutions: textList.optional(),
    tools_used: textList.optional(),
    activity_frequency: text(200).optional(),
    tech_savviness: text(200).optional(),
    decision_style: text(500).optional(),
  }).optional(),
  context_environment: z.strictObject({
    usage_context: text().optional(),
    devices: textList.optional(),
    time_constraints: text(500).optional(),
    social_context: text(500).optional(),
    influencers: textList.optional(),
  }).optional(),
  quotes: z.array(z.strictObject({ text: nonEmpty(1000), context: text(500).optional() })).max(20).optional(),
  scenario: z.strictObject({
    title: text(200).optional(),
    narrative: text(4000).optional(),
    trigger: text(1000).optional(),
    outcome: text(1000).optional(),
  }).optional(),
}).refine(hasAnyKey, AT_LEAST_ONE)

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

/** `product_context.py` STRING_FIELDS, with the same caps. */
export const PRODUCT_CONTEXT_STRING_FIELDS = {
  product_name: 200,
  one_liner: 200,
  target_users: 1000,
  problem_solved: 2000,
  key_features: 2000,
  differentiators: 2000,
  known_limitations: 2000,
  non_goals: 2000,
  success_metrics: 2000,
  free_form_notes: 4000,
} as const

/** `product_context.py` LIFECYCLE_STATES. */
export const LIFECYCLE_STATES = ['idea', 'mvp', 'beta', 'ga', 'mature'] as const

export const productContextUpdatesSchema = z.strictObject({
  product_name: text(PRODUCT_CONTEXT_STRING_FIELDS.product_name).optional(),
  one_liner: text(PRODUCT_CONTEXT_STRING_FIELDS.one_liner).optional(),
  target_users: text(PRODUCT_CONTEXT_STRING_FIELDS.target_users).optional(),
  problem_solved: text(PRODUCT_CONTEXT_STRING_FIELDS.problem_solved).optional(),
  key_features: text(PRODUCT_CONTEXT_STRING_FIELDS.key_features).optional(),
  differentiators: text(PRODUCT_CONTEXT_STRING_FIELDS.differentiators).optional(),
  known_limitations: text(PRODUCT_CONTEXT_STRING_FIELDS.known_limitations).optional(),
  non_goals: text(PRODUCT_CONTEXT_STRING_FIELDS.non_goals).optional(),
  success_metrics: text(PRODUCT_CONTEXT_STRING_FIELDS.success_metrics).optional(),
  free_form_notes: text(PRODUCT_CONTEXT_STRING_FIELDS.free_form_notes).optional(),
  current_state: z.enum(LIFECYCLE_STATES).optional(),
}).refine(hasAnyKey, AT_LEAST_ONE)

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

export const generateDocumentArgs = z.strictObject({
  project_id: idSchema,
  doc_type: z.enum(['prd', 'prfaq']),
  title: nonEmpty(200),
  feature_idea: nonEmpty(4000),
  persona_ids: idList.optional(),
  document_ids: idList.optional(),
})

export const generatePersonasArgs = z.strictObject({
  project_id: idSchema,
  persona_count: z.number().int().min(1).max(8),
  custom_instructions: z.string().max(2000).optional(),
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

/**
 * The form settings the assistant may change: flat text and on/off display
 * settings. Deliberately NOT: `theme` (CSS values rendered on customers' sites),
 * `custom_fields`, `rating_max`, `category`/`subcategory` (routing), and the
 * `project_id`/`document_id` validation links.
 */
export const FEEDBACK_FORM_UPDATABLE_FIELDS = [
  'enabled', 'name', 'title', 'description', 'question', 'placeholder',
  'submit_button_text', 'success_message', 'rating_enabled', 'rating_type',
  'collect_email', 'collect_name', 'dimension_defaults', 'tags',
] as const

/** Mirrors lambda/shared/dimension_config.py (DIMENSION_KEY_RE, DIMENSION_VALUE_RE, TAG_RE, limits); the route re-validates. */
const MAX_DIMENSION_DEFAULTS = 10
const dimensionDefaultsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().regex(/^[^\s#,:]{1,64}$/))
  .refine((d) => Object.keys(d).length <= MAX_DIMENSION_DEFAULTS, { message: `at most ${MAX_DIMENSION_DEFAULTS} dimension defaults` })
const formTagsSchema = z.array(z.string().trim().regex(/^[^\s#,:][^#,:]{0,63}$/)).max(20)

export const feedbackFormUpdatesSchema = z.strictObject({
  enabled: z.boolean().optional(),
  name: nonEmpty(200).optional(),
  title: text(200).optional(),
  description: text(1000).optional(),
  question: text(500).optional(),
  placeholder: text(200).optional(),
  submit_button_text: nonEmpty(50).optional(),
  success_message: text(500).optional(),
  rating_enabled: z.boolean().optional(),
  rating_type: z.enum(['stars', 'numeric', 'emoji']).optional(),
  collect_email: z.boolean().optional(),
  collect_name: z.boolean().optional(),
  dimension_defaults: dimensionDefaultsSchema.optional(),
  tags: formTagsSchema.optional(),
}).refine(hasAnyKey, AT_LEAST_ONE)

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
