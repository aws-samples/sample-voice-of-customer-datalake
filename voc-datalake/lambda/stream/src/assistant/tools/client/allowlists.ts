/**
 * The keys an `updates` object may carry, per write tool. Strict zod objects:
 * anything else is refused at validation, before an approval card is shown.
 *
 * The SPA's approval boundary (`frontend/src/assistant/approvals/schemas.ts`)
 * imports the `*UpdatesShape` objects and the label schemas through `@stream`
 * and adds its own "at least one field" message, so both sides accept the same
 * keys, nested shapes and limits. Browser-safe: zod and dimension-patterns only.
 *
 * Sources of truth:
 *   - persona: `lambda/api/projects.py::update_persona` `updatable_fields`,
 *     MINUS `avatar_url` / `avatar_prompt` (avatars change through the
 *     regenerate-avatar flow; a model-chosen URL would be rendered as an <img>)
 *     and `research_notes` (replacing the list would delete notes; use
 *     add_persona_note). Sections follow `schemas/persona.schema.json`.
 *   - product context: `lambda/api/product_context.py` STRING_FIELDS (with their
 *     max lengths) + `current_state` ∈ LIFECYCLE_STATES. LIST_FIELDS is empty.
 *   - feedback form: flat text/boolean display settings from
 *     `feedback_form_handler.py::UPDATABLE_FIELDS`, excluding `theme` (CSS on
 *     customers' sites), `custom_fields` (nested), `rating_max`,
 *     `category` / `subcategory` (routing) and the `project_id` / `document_id`
 *     validation links; plus `dimension_defaults` / `tags` (docs/dimensions.md),
 *     flat maps/lists the route validates against the dimension config.
 */
import { z } from 'zod';
import { DIMENSION_KEY_PATTERN, DIMENSION_VALUE_PATTERN } from '../dimension-patterns.js';

function nonEmpty<T extends Record<string, unknown>>(schema: z.ZodType<T>) {
  return schema.refine((value) => Object.values(value).some((v) => v !== undefined), 'updates must change at least one field');
}

const textField = (max = 2000) => z.string().max(max);
const required = (max: number) => z.string().trim().min(1).max(max);
const textList = z.array(z.string().max(500)).max(20);

export const PERSONA_UPDATE_FIELDS = [
  'name', 'tagline', 'confidence', 'identity', 'goals_motivations', 'pain_points', 'behaviors',
  'context_environment', 'quotes', 'scenario',
] as const;

/** The persona `updates` keys and their shapes (strict sections); `personaUpdatesSchema` adds the non-empty rule. */
export const personaUpdatesShape = {
  name: required(200).optional(),
  tagline: textField(500).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  identity: z.object({
    age_range: textField(100).optional(),
    location: textField(200).optional(),
    occupation: textField(200).optional(),
    income_bracket: textField(100).optional(),
    education: textField(200).optional(),
    family_status: textField(200).optional(),
    bio: textField().optional(),
  }).strict().optional(),
  goals_motivations: z.object({
    primary_goal: textField().optional(),
    secondary_goals: textList.optional(),
    success_definition: textField().optional(),
    underlying_motivations: textList.optional(),
  }).strict().optional(),
  pain_points: z.object({
    current_challenges: textList.optional(),
    blockers: textList.optional(),
    workarounds: textList.optional(),
    emotional_impact: textField().optional(),
  }).strict().optional(),
  behaviors: z.object({
    current_solutions: textList.optional(),
    tools_used: textList.optional(),
    activity_frequency: textField(200).optional(),
    tech_savviness: textField(200).optional(),
    decision_style: textField(500).optional(),
  }).strict().optional(),
  context_environment: z.object({
    usage_context: textField().optional(),
    devices: textList.optional(),
    time_constraints: textField(500).optional(),
    social_context: textField(500).optional(),
    influencers: textList.optional(),
  }).strict().optional(),
  quotes: z.array(z.object({ text: required(1000), context: textField(500).optional() }).strict()).max(20).optional(),
  scenario: z.object({
    title: textField(200).optional(),
    narrative: textField(4000).optional(),
    trigger: textField(1000).optional(),
    outcome: textField(1000).optional(),
  }).strict().optional(),
};

export const personaUpdatesSchema = nonEmpty(z.object(personaUpdatesShape).strict());

/** product_context.py STRING_FIELDS, name → max length. */
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
} as const;

export const LIFECYCLE_STATES = ['idea', 'mvp', 'beta', 'ga', 'mature'] as const;

const F = PRODUCT_CONTEXT_STRING_FIELDS;

/** The product-context `updates` keys, each string capped by PRODUCT_CONTEXT_STRING_FIELDS. */
export const productContextUpdatesShape = {
  product_name: textField(F.product_name).optional(),
  one_liner: textField(F.one_liner).optional(),
  target_users: textField(F.target_users).optional(),
  problem_solved: textField(F.problem_solved).optional(),
  key_features: textField(F.key_features).optional(),
  differentiators: textField(F.differentiators).optional(),
  known_limitations: textField(F.known_limitations).optional(),
  non_goals: textField(F.non_goals).optional(),
  success_metrics: textField(F.success_metrics).optional(),
  free_form_notes: textField(F.free_form_notes).optional(),
  current_state: z.enum(LIFECYCLE_STATES).optional(),
};

export const productContextUpdatesSchema = nonEmpty(z.object(productContextUpdatesShape).strict());

export const FEEDBACK_FORM_UPDATE_FIELDS = [
  'enabled', 'name', 'title', 'description', 'question', 'placeholder',
  'submit_button_text', 'success_message', 'rating_enabled', 'rating_type',
  'collect_email', 'collect_name', 'dimension_defaults', 'tags',
] as const;

/** Mirrors lambda/shared/dimension_config.py (MAX_DIMENSIONS, MAX_TAGS, TAG_RE); the route re-validates. */
const MAX_DIMENSION_DEFAULTS = 10;
export const MAX_LABEL_TAGS = 20;
const TAG_PATTERN = /^[^\s#,:][^#,:]{0,63}$/;

/** Shared by the form and scraper label fields (`dimension_defaults`). */
export const dimensionDefaultsSchema = z.record(z.string().regex(DIMENSION_KEY_PATTERN), z.string().regex(DIMENSION_VALUE_PATTERN))
  .refine((defaults) => Object.keys(defaults).length <= MAX_DIMENSION_DEFAULTS, {
    message: `at most ${MAX_DIMENSION_DEFAULTS} dimension defaults`,
  });
/** Shared by the form and scraper label fields (`tags`). */
export const labelTagsSchema = z.array(z.string().trim().regex(TAG_PATTERN)).max(MAX_LABEL_TAGS);

/** The feedback-form `updates` keys (flat display settings). */
export const feedbackFormUpdatesShape = {
  enabled: z.boolean().optional(),
  name: required(200).optional(),
  title: textField(200).optional(),
  description: textField(1000).optional(),
  question: textField(500).optional(),
  placeholder: textField(200).optional(),
  submit_button_text: required(50).optional(),
  success_message: textField(500).optional(),
  rating_enabled: z.boolean().optional(),
  rating_type: z.enum(['stars', 'numeric', 'emoji']).optional(),
  collect_email: z.boolean().optional(),
  collect_name: z.boolean().optional(),
  dimension_defaults: dimensionDefaultsSchema.optional(),
  tags: labelTagsSchema.optional(),
};

export const feedbackFormUpdatesSchema = nonEmpty(z.object(feedbackFormUpdatesShape).strict());
