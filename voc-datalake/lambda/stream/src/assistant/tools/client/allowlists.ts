/**
 * The keys an `updates` object may carry, per write tool. Strict zod objects:
 * anything else is refused at validation, before an approval card is shown.
 *
 * IDENTICAL to the SPA's own boundary (`frontend/src/assistant/approvals/
 * schemas.ts`) — same keys, nested shapes and limits; where the two ever
 * differed the narrower rule was taken. The frontend lockstep test
 * `approvals/allowlists.lockstep.test.ts` reads this file as text and pins the
 * key sets, so a key added here alone fails the frontend suite.
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
import { DIMENSION_KEY_PATTERN, DIMENSION_VALUE_PATTERN } from '../server/item-filters.js';

function nonEmpty<T extends Record<string, unknown>>(schema: z.ZodType<T, unknown>) {
  return schema.refine((value) => Object.values(value).some((v) => v !== undefined), 'updates must change at least one field');
}

const text = (max = 2000) => z.string().max(max);
const required = (max: number) => z.string().trim().min(1).max(max);
const textList = z.array(z.string().max(500)).max(20);

export const PERSONA_UPDATE_FIELDS = [
  'name', 'tagline', 'confidence', 'identity', 'goals_motivations', 'pain_points', 'behaviors',
  'context_environment', 'quotes', 'scenario',
] as const;

export const personaUpdatesSchema = nonEmpty(z.object({
  name: required(200).optional(),
  tagline: text(500).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  identity: z.object({
    age_range: text(100).optional(),
    location: text(200).optional(),
    occupation: text(200).optional(),
    income_bracket: text(100).optional(),
    education: text(200).optional(),
    family_status: text(200).optional(),
    bio: text().optional(),
  }).strict().optional(),
  goals_motivations: z.object({
    primary_goal: text().optional(),
    secondary_goals: textList.optional(),
    success_definition: text().optional(),
    underlying_motivations: textList.optional(),
  }).strict().optional(),
  pain_points: z.object({
    current_challenges: textList.optional(),
    blockers: textList.optional(),
    workarounds: textList.optional(),
    emotional_impact: text().optional(),
  }).strict().optional(),
  behaviors: z.object({
    current_solutions: textList.optional(),
    tools_used: textList.optional(),
    activity_frequency: text(200).optional(),
    tech_savviness: text(200).optional(),
    decision_style: text(500).optional(),
  }).strict().optional(),
  context_environment: z.object({
    usage_context: text().optional(),
    devices: textList.optional(),
    time_constraints: text(500).optional(),
    social_context: text(500).optional(),
    influencers: textList.optional(),
  }).strict().optional(),
  quotes: z.array(z.object({ text: required(1000), context: text(500).optional() }).strict()).max(20).optional(),
  scenario: z.object({
    title: text(200).optional(),
    narrative: text(4000).optional(),
    trigger: text(1000).optional(),
    outcome: text(1000).optional(),
  }).strict().optional(),
}).strict());

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

/** Built from the field → max-length map so the limits live in one place. */
const productContextStringShape: Record<string, z.ZodOptional<z.ZodString>> = Object.fromEntries(
  Object.entries(PRODUCT_CONTEXT_STRING_FIELDS).map(([field, max]) => [field, text(max).optional()]),
);

export const productContextUpdatesSchema = nonEmpty(z.object({
  ...productContextStringShape,
  current_state: z.enum(LIFECYCLE_STATES).optional(),
}).strict());

export const FEEDBACK_FORM_UPDATE_FIELDS = [
  'enabled', 'name', 'title', 'description', 'question', 'placeholder',
  'submit_button_text', 'success_message', 'rating_enabled', 'rating_type',
  'collect_email', 'collect_name', 'dimension_defaults', 'tags',
] as const;

/** Mirrors lambda/shared/dimension_config.py (MAX_DIMENSIONS, MAX_TAGS, TAG_RE); the route re-validates. */
const MAX_DIMENSION_DEFAULTS = 10;
const MAX_TAGS = 20;
const TAG_PATTERN = /^[^\s#,:][^#,:]{0,63}$/;

const dimensionDefaults = z.record(z.string().regex(DIMENSION_KEY_PATTERN), z.string().regex(DIMENSION_VALUE_PATTERN))
  .refine((defaults) => Object.keys(defaults).length <= MAX_DIMENSION_DEFAULTS, {
    message: `at most ${MAX_DIMENSION_DEFAULTS} dimension defaults`,
  });
const formTags = z.array(z.string().trim().regex(TAG_PATTERN)).max(MAX_TAGS);

export const feedbackFormUpdatesSchema = nonEmpty(z.object({
  enabled: z.boolean().optional(),
  name: required(200).optional(),
  title: text(200).optional(),
  description: text(1000).optional(),
  question: text(500).optional(),
  placeholder: text(200).optional(),
  submit_button_text: required(50).optional(),
  success_message: text(500).optional(),
  rating_enabled: z.boolean().optional(),
  rating_type: z.enum(['stars', 'numeric', 'emoji']).optional(),
  collect_email: z.boolean().optional(),
  collect_name: z.boolean().optional(),
  dimension_defaults: dimensionDefaults.optional(),
  tags: formTags.optional(),
}).strict());
