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
import { toOptionalFiniteNumber } from '../../api/lenientFields'
import { supportedLanguages } from '../../i18n/languages'
import { DEFAULT_THEME } from './model/formsV2'
import { ROUTING_AND_LINK } from './model/keptFields'

/**
 * The v1 defaults a sparse record's fields fall back to (the old Blank template's). v1 records are read
 * here for the list and Prioritization; the builder reads them as v2 (model/migrateV1.ts).
 */
export const V1_FORM_DEFAULTS = {
  title: 'Share Your Feedback',
  description: 'We value your opinion. Please share your experience with us.',
  question: 'How was your experience?',
  placeholder: 'Tell us about your experience...',
  rating_enabled: true,
  rating_type: 'stars',
  rating_max: 5,
  submit_button_text: 'Submit Feedback',
  success_message: 'Thank you for your feedback!',
  theme: DEFAULT_THEME,
  collect_email: false,
  collect_name: false,
} as const

// Per-field catches deep-merge a PARTIAL theme (set colors survive, missing
// ones default); the object-level catch covers theme: null/absent wholesale.
// Loose: unknown theme keys survive edit round-trips (see form schema note).
const themeSchema = z
  .looseObject({
    primary_color: z.string().catch(V1_FORM_DEFAULTS.theme.primary_color),
    background_color: z.string().catch(V1_FORM_DEFAULTS.theme.background_color),
    text_color: z.string().catch(V1_FORM_DEFAULTS.theme.text_color),
    border_radius: z.string().catch(V1_FORM_DEFAULTS.theme.border_radius),
  })
  .catch(() => ({ ...V1_FORM_DEFAULTS.theme }))

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
  title: z.string().catch(V1_FORM_DEFAULTS.title),
  description: z.string().catch(V1_FORM_DEFAULTS.description),
  question: z.string().catch(V1_FORM_DEFAULTS.question),
  // Forms stored before 7.04.00 have neither: '' is "Tell us more" and the visitor's browser language,
  // which is how the widget rendered them before.
  text_question: z.string().catch(''),
  language: z.enum(['', ...supportedLanguages]).catch(''),
  placeholder: z.string().catch(V1_FORM_DEFAULTS.placeholder),
  rating_enabled: z.boolean().catch(V1_FORM_DEFAULTS.rating_enabled),
  rating_type: z.enum(['stars', 'numeric', 'emoji']).catch(V1_FORM_DEFAULTS.rating_type),
  rating_max: z.preprocess(toOptionalFiniteNumber, z.number().catch(V1_FORM_DEFAULTS.rating_max)),
  submit_button_text: z.string().catch(V1_FORM_DEFAULTS.submit_button_text),
  success_message: z.string().catch(V1_FORM_DEFAULTS.success_message),
  theme: themeSchema,
  collect_email: z.boolean().catch(V1_FORM_DEFAULTS.collect_email),
  collect_name: z.boolean().catch(V1_FORM_DEFAULTS.collect_name),
  custom_fields: customFieldsSchema,
  // The routing, and the optional link to the project/document this form validates. Defaults to ''
  // like every other absent string field, so a record persisted before the
  // link existed — or one that deliberately validates nothing — normalizes to
  // "unlinked" rather than being dropped. Declaring both fields explicitly
  // (rather than relying on the loose object's passthrough) is what makes a
  // stored link survive the edit round-trip with a known type: the editor
  // reads them off a normalized record and writes them straight back.
  ...ROUTING_AND_LINK,
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
