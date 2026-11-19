/**
 * @fileoverview The forms-v2 wire, read leniently at the query boundary (as `formSchema.ts` reads v1): a missing or
 * malformed field degrades to its default instead of rejecting the form, a question of an unknown type is left out
 * with a warning, and unknown keys are dropped (the editor writes only what it knows; the server validates the whole).
 *
 * `parseFormV2` reads a v2 form's content; `toWireForm` writes the editor's form back (the body of a create or a save).
 *
 * @module pages/FeedbackForms/model/formsV2Schema
 */
import { z } from 'zod'
import type {
  ChoiceQuestion, Ending, FormLanguage, FormV2, HiddenField, I18nText, OpenTextQuestion, Question, Rule, StatementQuestion,
  Welcome,
} from './formsV2'
import {
  DEFAULT_THEME, DISPLAYS, FORM_LANGUAGES, INPUT_TYPES, RATING_RANGES, RATING_SCALES, RULE_OPS,
  SHUFFLES, TEST_RECORDS, THEME_FONTS, THEME_MODES, THEME_TEXT_SIZES, isFormLanguage,
} from './formsV2'

const text = z.record(z.string(), z.unknown()).catch({}).transform((raw): I18nText =>
  Object.fromEntries(Object.entries(raw).filter((entry): entry is [FormLanguage, string] =>
    isFormLanguage(entry[0]) && typeof entry[1] === 'string')))
const optionalText = text.optional().catch(undefined)
const bool = (fallback: boolean) => z.boolean().catch(fallback)

const ruleValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional().catch(undefined)
const rule = z.object({
  when: z.object({ op: z.enum(RULE_OPS), value: ruleValue }),
  then: z.object({ jump_to: z.string().min(1) }),
})
/** Each rule on its own: one malformed rule is dropped, not the question's whole logic. */
const logic = z.array(z.unknown()).catch([]).transform((items): Rule[] =>
  items.flatMap((item) => {
    const parsed = rule.safeParse(item)
    return parsed.success ? [parsed.data] : []
  }))

const base = {
  id: z.string().min(1),
  headline: text,
  subheader: optionalText,
  required: bool(false),
  button_label: optionalText,
  logic: logic.optional(),
}

const category = z.object({ category: z.string().min(1), subcategory: z.string().optional().catch(undefined) })
const option = z.object({ code: z.string().min(1), label: text, category: category.optional().catch(undefined) })
const options = z.array(z.unknown()).catch([]).transform((items) => items.flatMap((item) => {
  const parsed = option.safeParse(item)
  return parsed.success ? [parsed.data] : []
}))
const count = z.number().int().nonnegative().optional().catch(undefined)

const choice = z.object({
  ...base,
  type: z.enum(['single_select', 'multi_select']),
  options,
  other: z.object({ enabled: bool(false), label: optionalText, placeholder: optionalText }).catch({ enabled: false }),
  none: z.object({ enabled: bool(false), label: optionalText }).catch({ enabled: false }),
  shuffle: z.enum(SHUFFLES).catch('none'),
  display: z.enum(DISPLAYS).catch('auto'),
  min: count,
  max: count,
})
const openText = z.object({
  ...base,
  type: z.literal('open_text'),
  long: bool(true),
  input_type: z.enum(INPUT_TYPES).catch('text'),
  placeholder: optionalText,
  max_chars: z.number().int().positive().optional().catch(undefined),
})
const rating = z.object({
  ...base,
  type: z.literal('rating'),
  scale: z.enum(RATING_SCALES).catch('star'),
  range: z.literal(RATING_RANGES).catch(5),
  lower_label: optionalText,
  upper_label: optionalText,
})
const score = z.object({ ...base, type: z.enum(['nps', 'csat', 'ces']), lower_label: optionalText, upper_label: optionalText })
const statement = z.object({
  ...base,
  type: z.literal('statement'),
  cta: z.object({ label: text, url: z.string().optional().catch(undefined) }).optional().catch(undefined),
})
const consent = z.object({ ...base, type: z.literal('consent'), label: text })
const HIDDEN_FIELD = { show: false, required: false }
const fieldSetting = z.object({ show: bool(false), required: bool(false) }).catch(HIDDEN_FIELD)
const contact = z.object({
  ...base,
  type: z.literal('contact_info'),
  fields: z.object({ name: fieldSetting, email: fieldSetting, phone: fieldSetting, company: fieldSetting })
    .catch({ name: HIDDEN_FIELD, email: HIDDEN_FIELD, phone: HIDDEN_FIELD, company: HIDDEN_FIELD }),
})

const question = z.discriminatedUnion('type', [choice, openText, rating, score, statement, consent, contact])

const questions = z.array(z.unknown()).catch([]).transform((items) => items.flatMap((item) => {
  const parsed = question.safeParse(item)
  if (parsed.success) return [parsed.data]
  console.warn('Leaving out a form question that is not one the editor knows:', parsed.error.issues, item)
  return []
}))

const ending = z.object({
  id: z.string().min(1),
  title: text,
  description: optionalText,
  button: z.object({ label: text, url: z.string() }).optional().catch(undefined),
})
const endings = z.array(z.unknown()).catch([]).transform((items) => items.flatMap((item) => {
  const parsed = ending.safeParse(item)
  return parsed.success ? [parsed.data] : []
}))
const hiddenField = z.object({ id: z.string().min(1), label: z.string().optional().catch(undefined) })
const hiddenFields = z.array(z.unknown()).catch([]).transform((items) => items.flatMap((item) => {
  const parsed = hiddenField.safeParse(item)
  return parsed.success ? [parsed.data] : []
}))

const language = z.enum(FORM_LANGUAGES)
const languages = z.array(z.unknown()).catch([]).transform((items) => items.filter(isFormLanguage))
/** A stored colour: `#rgb`, `#rrggbb`, or an old form's `#rrggbbaa` (lambda/shared/form_theme.py HEX_COLOR). */
const STORED_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** The dark palette is new in 7.55.01: `#rgb` or `#rrggbb` only (form_theme.py PALETTE_HEX). */
const PALETTE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const colour = (pattern: RegExp, fallback: string) => z.string().regex(pattern).catch(fallback)
const darkPalette = z.object({
  primary_color: colour(PALETTE_HEX, DEFAULT_THEME.dark.primary_color),
  background_color: colour(PALETTE_HEX, DEFAULT_THEME.dark.background_color),
  text_color: colour(PALETTE_HEX, DEFAULT_THEME.dark.text_color),
}).catch({ ...DEFAULT_THEME.dark })

/**
 * A form's theme as the editor holds it, every field present: one missing (a theme stored before 7.55.01 has no mode,
 * dark palette, font or size) or unusable is its default, as the server reads it (form_theme.py `with_defaults`).
 * Shared with the v1 migration (migrateV1.ts).
 */
export const themeSchema = z.object({
  primary_color: colour(STORED_HEX, DEFAULT_THEME.primary_color),
  background_color: colour(STORED_HEX, DEFAULT_THEME.background_color),
  text_color: colour(STORED_HEX, DEFAULT_THEME.text_color),
  border_radius: z.string().regex(/^\d{1,2}px$/).catch(DEFAULT_THEME.border_radius),
  mode: z.enum(THEME_MODES).catch(DEFAULT_THEME.mode),
  dark: darkPalette,
  font: z.enum(THEME_FONTS).catch(DEFAULT_THEME.font),
  text_size: z.enum(THEME_TEXT_SIZES).catch(DEFAULT_THEME.text_size),
}).catch({ ...DEFAULT_THEME })
const theme = themeSchema

const formV2 = z.object({
  name: z.string().catch(''),
  enabled: bool(false),
  language: language.catch('en'),
  languages,
  welcome: z.object({ enabled: bool(false), title: text, description: optionalText, button_label: optionalText })
    .catch({ enabled: false, title: {} }),
  questions,
  hidden_fields: hiddenFields,
  endings,
  settings: z.object({
    test: z.object({ link_enabled: bool(false), record: z.enum(TEST_RECORDS).catch('tag') })
      .catch({ link_enabled: false, record: 'tag' }),
  }).catch({ test: { link_enabled: false, record: 'tag' } }),
  theme,
  category: z.string().catch(''),
  subcategory: z.string().catch(''),
  project_id: z.string().catch(''),
  document_id: z.string().catch(''),
  custom_fields: z.array(z.unknown()).catch([]),
  dimension_defaults: z.record(z.string(), z.string()).catch({}),
  tags: z.array(z.string()).catch([]),
  form_type: z.enum(['standard', 'prototype_pin']).optional().catch(undefined),
})

/** A v2 form's content as the editor holds it; null when `raw` is not an object at all. */
export function parseFormV2(raw: unknown): FormV2 | null {
  const parsed = formV2.safeParse(raw)
  if (!parsed.success) return null
  const form = parsed.data
  // The primary is always one of the form's languages, and first.
  const others = form.languages.filter((lng) => lng !== form.language)
  return { schema_version: 2, ...form, languages: [form.language, ...new Set(others)] }
}

/** A text without its empty entries, or undefined when nothing is left (an optional text the server need not see). */
function cleanText(value: I18nText | undefined): I18nText | undefined {
  if (value === undefined) return undefined
  const kept = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry.trim() !== ''))
  return Object.keys(kept).length === 0 ? undefined : kept
}

function wireChoice(q: ChoiceQuestion): Record<string, unknown> {
  const multi = q.type === 'multi_select'
  return {
    options: q.options.map((o) => ({ code: o.code, label: cleanText(o.label) ?? {}, category: o.category })),
    other: { enabled: q.other.enabled, label: cleanText(q.other.label), placeholder: cleanText(q.other.placeholder) },
    ...(multi ? { none: { enabled: q.none.enabled, label: cleanText(q.none.label) }, min: q.min, max: q.max } : {}),
    shuffle: q.shuffle,
    display: q.display,
  }
}

/** A required text: its entries, `{}` when none (the server says what is missing). */
const requiredText = (value: I18nText): I18nText => cleanText(value) ?? {}

/** A long text has no answer type (it is always text). */
const wireOpenText = (q: OpenTextQuestion) => ({
  long: q.long, input_type: q.long ? 'text' : q.input_type, placeholder: cleanText(q.placeholder), max_chars: q.max_chars,
})

const wireStatement = (q: StatementQuestion) => ({ cta: q.cta === undefined ? undefined : { label: requiredText(q.cta.label), url: q.cta.url } })

function wireOwnFields(q: Question): Record<string, unknown> {
  switch (q.type) {
    case 'single_select': case 'multi_select': return wireChoice(q)
    case 'open_text': return wireOpenText(q)
    case 'rating': return { scale: q.scale, range: q.range, lower_label: cleanText(q.lower_label), upper_label: cleanText(q.upper_label) }
    case 'nps': case 'csat': case 'ces': return { lower_label: cleanText(q.lower_label), upper_label: cleanText(q.upper_label) }
    case 'statement': return wireStatement(q)
    case 'consent': return { label: requiredText(q.label) }
    case 'contact_info': return { fields: q.fields }
  }
}

function wireQuestion(q: Question): Record<string, unknown> {
  return {
    id: q.id,
    type: q.type,
    headline: cleanText(q.headline) ?? {},
    subheader: cleanText(q.subheader),
    required: q.type === 'statement' ? false : q.required,
    button_label: cleanText(q.button_label),
    logic: q.logic === undefined || q.logic.length === 0 ? undefined : q.logic,
    ...wireOwnFields(q),
  }
}

const wireEnding = (e: Ending) => ({
  id: e.id, title: cleanText(e.title) ?? {}, description: cleanText(e.description),
  button: e.button === undefined ? undefined : { label: cleanText(e.button.label) ?? {}, url: e.button.url },
})
const wireWelcome = (w: Welcome) => ({
  enabled: w.enabled, title: cleanText(w.title) ?? {}, description: cleanText(w.description), button_label: cleanText(w.button_label),
})
const wireHidden = (h: HiddenField) => ({ id: h.id, label: h.label === undefined || h.label.trim() === '' ? undefined : h.label })

/** The body a create or a save sends: the form in schema version 2 (JSON drops the undefined optional fields). */
export function toWireForm(form: FormV2): Record<string, unknown> {
  return {
    schema_version: 2,
    name: form.name,
    enabled: form.enabled,
    language: form.language,
    languages: form.languages,
    welcome: wireWelcome(form.welcome),
    questions: form.questions.map(wireQuestion),
    hidden_fields: form.hidden_fields.map(wireHidden),
    endings: form.endings.map(wireEnding),
    settings: form.settings,
    theme: form.theme,
    category: form.category,
    subcategory: form.subcategory,
    project_id: form.project_id,
    document_id: form.document_id,
    custom_fields: form.custom_fields,
    dimension_defaults: form.dimension_defaults,
    tags: form.tags,
    ...(form.form_type === undefined ? {} : { form_type: form.form_type }),
  }
}
