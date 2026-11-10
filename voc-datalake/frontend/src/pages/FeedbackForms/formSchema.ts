/**
 * @fileoverview Runtime validation/normalization for feedback form records.
 *
 * The wire can deliver sparse form records: every field of the form may be
 * absent — or explicitly null — on rows persisted before that field existed
 * (and on sparse fixtures). Reading e.g. `theme.primary_color` off such a
 * record crashed the whole /feedback-forms route (issue #171).
 *
 * Following the project convention (see api/feedbackSchema.ts), this module
 * makes the declared FeedbackForm contract true at the query boundary with a
 * lenient Zod schema: invalid or missing fields degrade to defaults instead
 * of rejecting the record, because the previous behavior never threw and
 * normalization must not regress a rendering list into a hard failure.
 *
 * @module pages/FeedbackForms/formSchema
 */
import { z } from 'zod'
import type { FeedbackForm } from '../../api/types'
import { OptionalStringMapSchema, OptionalTagsSchema } from '../../api/dimensionsSchema'
import { defaultFormConfig } from './formTemplates'
import { toOptionalFiniteNumber } from '../../api/lenientFields'

// Per-field catches deep-merge a PARTIAL theme (set colors survive, missing
// ones default); the object-level catch covers theme: null/absent wholesale.
// Loose: unknown theme keys survive edit round-trips (see form schema note).
const themeSchema = z
  .looseObject({
    primary_color: z.string().catch(defaultFormConfig.theme.primary_color),
    background_color: z.string().catch(defaultFormConfig.theme.background_color),
    text_color: z.string().catch(defaultFormConfig.theme.text_color),
    border_radius: z.string().catch(defaultFormConfig.theme.border_radius),
  })
  .catch(() => ({ ...defaultFormConfig.theme }))

/** A form's theme, render-safe: a missing theme or colour falls back to the default. */
export function normalizeFormTheme(raw: unknown): FeedbackForm['theme'] {
  return themeSchema.parse(raw)
}

const customFieldSchema = z.looseObject({
  id: z.string().catch(''),
  label: z.string().catch(''),
  type: z.string().catch('text'),
  required: z.boolean().catch(false),
})

// Per-item salvage: one junk element must not discard the whole array
// (the array-level catch only covers a non-array wholesale). Items that
// aren't objects at all are filtered; object items survive via the
// per-field catches above.
const customFieldsSchema = z
  .array(z.unknown())
  .catch(() => [])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = customFieldSchema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    }),
  )

/**
 * Schema for a stored feedback form.
 *
 * - Loose object: unknown backend fields pass through untouched, so a
 *   record read from the list and saved back by the edit modal
 *   round-trips without silent data loss (same rationale as
 *   api/scrapersSchema.ts).
 * - form_id is the one field that CANNOT be invented: it feeds React list
 *   keys and the ['form-stats', form_id] query key, so defaulting it to ''
 *   would make two identity-less records collide on both. Records without
 *   a usable form_id are dropped (with a warning) by normalizeFeedbackForms.
 * - Every other field falls back to defaultFormConfig on absence, null, or
 *   wrong type; rating_max additionally coerces numeric strings.
 * - Enumerated objects/arrays (theme, custom_fields) are re-parsed into
 *   fresh instances, so normalized forms never share those references with
 *   each other or with inputs. Passthrough (unknown) values are shallow-
 *   copied and DO share references with the input object.
 */
const FeedbackFormSchema = z.looseObject({
  form_id: z.string().min(1),
  name: z.string().catch(''),
  enabled: z.boolean().catch(false),
  title: z.string().catch(defaultFormConfig.title),
  description: z.string().catch(defaultFormConfig.description),
  question: z.string().catch(defaultFormConfig.question),
  placeholder: z.string().catch(defaultFormConfig.placeholder),
  rating_enabled: z.boolean().catch(defaultFormConfig.rating_enabled),
  rating_type: z.enum(['stars', 'numeric', 'emoji']).catch(defaultFormConfig.rating_type),
  rating_max: z.preprocess(toOptionalFiniteNumber, z.number().catch(defaultFormConfig.rating_max)),
  submit_button_text: z.string().catch(defaultFormConfig.submit_button_text),
  success_message: z.string().catch(defaultFormConfig.success_message),
  theme: themeSchema,
  collect_email: z.boolean().catch(defaultFormConfig.collect_email),
  collect_name: z.boolean().catch(defaultFormConfig.collect_name),
  custom_fields: customFieldsSchema,
  category: z.string().catch(''),
  subcategory: z.string().catch(''),
  // Optional link to the project/document this form validates. Defaults to ''
  // like every other absent string field, so a record persisted before the
  // link existed — or one that deliberately validates nothing — normalizes to
  // "unlinked" rather than being dropped. Declaring both fields explicitly
  // (rather than relying on the loose object's passthrough) is what makes a
  // stored link survive the edit round-trip with a known type: the editor
  // reads them off a normalized record and writes them straight back.
  project_id: z.string().catch(''),
  document_id: z.string().catch(''),
  // Older records have no type and stay that way (absent = an ordinary form).
  form_type: z.enum(['standard', 'prototype_pin']).optional().catch(undefined),
  // Stamped on every submission (an embed's `dimensions` option wins per key).
  dimension_defaults: OptionalStringMapSchema,
  tags: OptionalTagsSchema,
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
})

/**
 * Normalize a wire list for rendering: records without a usable form_id are
 * dropped with a warning instead of defaulting to '' — an invented identity
 * would collide React list keys and the ['form-stats', form_id] query key
 * across records. Sparse-but-identified records normalize as usual. A list
 * that is missing (or not a list) normalizes to no forms.
 */
export function normalizeFeedbackForms(rawForms: unknown): FeedbackForm[] {
  if (!Array.isArray(rawForms)) return []
  return rawForms.flatMap((raw: unknown) => {
    const parsed = FeedbackFormSchema.safeParse(raw)
    if (!parsed.success) {
      // Neutral wording: today the only non-catching field is form_id, but
      // the failure set grows with any future catch-less field.
      console.warn('Dropping feedback form record that failed schema validation:', parsed.error.issues, raw)
      return []
    }
    return [parsed.data]
  })
}
