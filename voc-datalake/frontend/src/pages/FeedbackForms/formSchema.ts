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
import type { FeedbackForm } from '../../api/client'
import { defaultFormConfig } from './formTemplates'

/** What the wire is expected to deliver for a stored form: identity fields
 * plus any subset of the rest — including a partial nested theme. Used by
 * tests to build sparse fixtures without type assertions. */
export type SparseFeedbackForm =
  Partial<Omit<FeedbackForm, 'theme'>> &
  Pick<FeedbackForm, 'form_id' | 'name' | 'enabled'> &
  { theme?: Partial<FeedbackForm['theme']> }

/** Coerce DynamoDB string round-trips like "5" to numbers; null/'' become
 * undefined so the field-level catch supplies the default instead of 0. */
function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

// Per-field catches deep-merge a PARTIAL theme (set colors survive, missing
// ones default); the object-level catch covers theme: null/absent wholesale.
const themeSchema = z
  .object({
    primary_color: z.string().catch(defaultFormConfig.theme.primary_color),
    background_color: z.string().catch(defaultFormConfig.theme.background_color),
    text_color: z.string().catch(defaultFormConfig.theme.text_color),
    border_radius: z.string().catch(defaultFormConfig.theme.border_radius),
  })
  .catch(() => ({ ...defaultFormConfig.theme }))

const customFieldSchema = z.object({
  id: z.string().catch(''),
  label: z.string().catch(''),
  type: z.string().catch('text'),
  required: z.boolean().catch(false),
})

/**
 * Schema for a stored feedback form.
 *
 * - Identity fields degrade to safe fallbacks rather than rejecting the row.
 * - Every other field falls back to defaultFormConfig on absence, null, or
 *   wrong type; rating_max additionally coerces numeric strings.
 * - Zod returns fresh objects/arrays, so no two normalized forms share
 *   default (or input) references.
 * - Unknown keys (DynamoDB internal attributes) are stripped.
 */
export const FeedbackFormSchema = z.object({
  form_id: z.string().catch(''),
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
  custom_fields: z.array(customFieldSchema).catch(() => []),
  category: z.string().catch(''),
  subcategory: z.string().catch(''),
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
})

/**
 * Make the declared FeedbackForm contract true for one wire record.
 * Unparseable fields degrade to defaults per the schema; like the
 * feedbackSchema.ts precedent, a non-object record is a hard error —
 * that's a broken API response, not a sparse row.
 */
export function normalizeFeedbackForm(raw: unknown): FeedbackForm {
  return FeedbackFormSchema.parse(raw)
}
