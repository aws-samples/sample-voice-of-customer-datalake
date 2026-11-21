/**
 * @fileoverview A v1 form read as v2 (contract "Migration from v1": read-time and lossless; written back as v2 on the
 * next save). The server migrates at read time; the editor does the same when it is handed a v1 record (an older
 * API, a fixture), so it always edits v2.
 *
 * - The welcome screen is on, with v1's title and description (v1 always opened on it).
 * - `rating_enabled` becomes a rating question whose headline is `question`.
 * - The text step becomes `open_text` with `long: true`: its headline is `text_question`, else `question` when the
 *   rating is off, else "Tell us more" in the form's language. Its placeholder is kept.
 * - `collect_name` / `collect_email` become one `contact_info` question.
 * - `success_message` becomes the first ending; `submit_button_text` the last question's button label.
 * - An empty `language` (a version 1 form's "the visitor's browser") takes the deployment's default, which the author
 *   confirms in the builder (D15).
 *
 * @module pages/FeedbackForms/model/migrateV1
 */
import { z } from 'zod'
import type { ContactQuestion, FormLanguage, FormV2, Question, RatingQuestion, RatingRange } from './formsV2'
import { RATING_RANGES, isFormLanguage } from './formsV2'
import { KEPT_FIELDS } from './keptFields'
import { textOf } from './i18nText'

const v1 = z.object({
  name: z.string().catch(''),
  enabled: z.boolean().catch(false),
  title: z.string().catch(''),
  description: z.string().catch(''),
  question: z.string().catch(''),
  text_question: z.string().catch(''),
  language: z.string().catch(''),
  placeholder: z.string().catch(''),
  rating_enabled: z.boolean().catch(false),
  rating_type: z.enum(['stars', 'numeric', 'emoji']).catch('stars'),
  rating_max: z.coerce.number().catch(5),
  submit_button_text: z.string().catch(''),
  success_message: z.string().catch(''),
  collect_name: z.boolean().catch(false),
  collect_email: z.boolean().catch(false),
})

/** What a form keeps from v1 unchanged: the theme, the routing, the linked project, dimension defaults and tags. */
const keptFields = z.object(KEPT_FIELDS)

const SCALES = { stars: 'star', numeric: 'number', emoji: 'smiley' } as const

/** v1's `rating_max` as the nearest v2 range (a face scale has at most 5 points). */
function rangeOf(max: number, scale: RatingQuestion['scale']): RatingRange {
  const allowed = scale === 'smiley' ? RATING_RANGES.filter((range) => range <= 5) : RATING_RANGES
  return allowed.reduce((best, range) => (Math.abs(range - max) < Math.abs(best - max) ? range : best), 5)
}

export interface MigratedForm {
  readonly form: FormV2
  /** v1's language was '' (the visitor's browser): the primary is the deployment default until the author confirms. */
  readonly languageUnconfirmed: boolean
}

/**
 * The words a migrated form needs in its language: "Tell us more" (the text step's headline after a rating, when v1
 * had no follow-up question) and the contact question's headline (v1 asked for a name and an email without one).
 */
export type MigrationCopy = (key: 'tellUsMore' | 'contactHeadline', language: FormLanguage) => string

type V1 = z.infer<typeof v1>

function contactOf(old: V1, lng: FormLanguage, copy: MigrationCopy): ContactQuestion | null {
  if (!old.collect_name && !old.collect_email) return null
  return {
    id: 'q_contact', type: 'contact_info', headline: textOf(lng, copy('contactHeadline', lng)), required: true,
    fields: {
      name: { show: old.collect_name, required: old.collect_name },
      email: { show: old.collect_email, required: old.collect_email },
      phone: { show: false, required: false },
      company: { show: false, required: false },
    },
  }
}

function questionsOf(old: V1, lng: FormLanguage, copy: MigrationCopy): Question[] {
  const scale = SCALES[old.rating_type]
  const rating: Question | null = old.rating_enabled
    ? { id: 'q_rating', type: 'rating', headline: textOf(lng, old.question), required: true, scale, range: rangeOf(old.rating_max, scale) }
    : null
  const fallback = old.rating_enabled ? copy('tellUsMore', lng) : old.question
  const text: Question = {
    id: 'q_text', type: 'open_text', headline: textOf(lng, old.text_question === '' ? fallback : old.text_question),
    required: true, long: true, input_type: 'text',
    placeholder: old.placeholder === '' ? undefined : textOf(lng, old.placeholder),
  }
  const questions = [rating, text, contactOf(old, lng, copy)].filter((question) => question !== null)
  if (old.submit_button_text === '') return questions
  // v1's submit button text labels the last step's button.
  return questions.map((question, index) => (index === questions.length - 1 ? { ...question, button_label: textOf(lng, old.submit_button_text) } : question))
}

/** `raw` (a v1 record) as a v2 form. `defaultLanguage` is the deployment's default UI language (D15). */
export function migrateV1Form(raw: unknown, defaultLanguage: FormLanguage, copy: MigrationCopy): MigratedForm {
  const record = typeof raw === 'object' && raw !== null ? raw : {}
  const old = v1.parse(record)
  const lng: FormLanguage = isFormLanguage(old.language) ? old.language : defaultLanguage
  return {
    languageUnconfirmed: !isFormLanguage(old.language),
    form: {
      schema_version: 2,
      name: old.name,
      enabled: old.enabled,
      language: lng,
      languages: [lng],
      welcome: { enabled: true, title: textOf(lng, old.title), description: old.description === '' ? undefined : textOf(lng, old.description) },
      questions: questionsOf(old, lng, copy),
      hidden_fields: [],
      endings: [{ id: 'end_thanks', title: textOf(lng, old.success_message) }],
      settings: { test: { link_enabled: false, record: 'tag' } },
      ...keptFields.parse(record),
    },
  }
}
