/**
 * @fileoverview A feedback form in schema version 2 (7.55.00, docs/feedback-forms.md): the questions, their
 * logic, the hidden fields, the endings, the languages and the test settings, plus what a form keeps from v1 (theme,
 * category routing, the linked project, dimension defaults and tags).
 *
 * These are the editor's types. The wire is read leniently by `formsV2Schema.ts` (and v1 records are migrated by
 * `migrateV1.ts`); `toWireForm` there writes this shape back. The limits are the contract's; `validateForm.ts` checks
 * them before a save, as the server does after.
 *
 * @module pages/FeedbackForms/model/formsV2
 */
import { supportedLanguages } from '../../../i18n/languages'
import type { SupportedLanguage } from '../../../i18n/languages'
import { KIRO_LIGHT_HEX } from '../../../theme/printPalette'

/** The form languages are the app's nine. */
export const FORM_LANGUAGES = supportedLanguages
export type FormLanguage = SupportedLanguage

/** One text in each of the form's languages. The primary language's entry is required; others fall back to it. */
export type I18nText = Partial<Record<FormLanguage, string>>

/** The contract's limits. */
export const LIMITS = {
  questions: 30,
  endings: 5,
  hiddenFields: 20,
  options: 50,
  maxChars: 5000,
  headlineChars: 300,
  describeChars: 2000,
} as const

export type QuestionType =
  | 'single_select' | 'multi_select' | 'open_text' | 'rating' | 'nps' | 'csat' | 'ces' | 'statement' | 'consent' | 'contact_info'

export const RULE_OPS = [
  'equals', 'not_equals', 'includes_any', 'includes_all', 'lt', 'lte', 'gt', 'gte', 'submitted', 'skipped',
] as const
export type RuleOp = (typeof RULE_OPS)[number]

/** A rule's value: an option code, several codes, a score, or a consent's yes/no. Absent for submitted/skipped. */
export type RuleValue = string | number | boolean | readonly string[]

/** If this question's answer [op] [value], go to a later question or an ending. The first rule that matches wins. */
export interface Rule {
  readonly when: { readonly op: RuleOp; readonly value?: RuleValue }
  readonly then: { readonly jump_to: string }
}

interface QuestionBase {
  readonly id: string
  readonly headline: I18nText
  readonly subheader?: I18nText
  readonly required: boolean
  readonly button_label?: I18nText
  readonly logic?: readonly Rule[]
}

export const INPUT_TYPES = ['text', 'email', 'number', 'phone', 'url'] as const
export type InputType = (typeof INPUT_TYPES)[number]

export interface OpenTextQuestion extends QuestionBase {
  readonly type: 'open_text'
  readonly long: boolean
  readonly input_type: InputType
  readonly placeholder?: I18nText
  readonly max_chars?: number
}

/** The category an answered option files its feedback under, by name (as the form's own routing). */
export interface OptionCategory {
  readonly category: string
  readonly subcategory?: string
}

export interface ChoiceOption {
  readonly code: string
  readonly label: I18nText
  readonly category?: OptionCategory
}

export const SHUFFLES = ['none', 'all', 'except_last'] as const
export type Shuffle = (typeof SHUFFLES)[number]
export const DISPLAYS = ['auto', 'list', 'dropdown', 'chips'] as const
export type ChoiceDisplay = (typeof DISPLAYS)[number]

interface OtherRow {
  readonly enabled: boolean
  readonly label?: I18nText
  readonly placeholder?: I18nText
}

interface NoneRow {
  readonly enabled: boolean
  readonly label?: I18nText
}

export interface ChoiceQuestion extends QuestionBase {
  readonly type: 'single_select' | 'multi_select'
  readonly options: readonly ChoiceOption[]
  readonly other: OtherRow
  /** Multiple choice only: an exclusive "None of these". */
  readonly none: NoneRow
  readonly shuffle: Shuffle
  readonly display: ChoiceDisplay
  /** Multiple choice only. */
  readonly min?: number
  readonly max?: number
}

export const RATING_SCALES = ['star', 'number', 'smiley'] as const
export type RatingScale = (typeof RATING_SCALES)[number]
export const RATING_RANGES = [3, 4, 5, 7, 10] as const
export type RatingRange = (typeof RATING_RANGES)[number]

export interface RatingQuestion extends QuestionBase {
  readonly type: 'rating'
  readonly scale: RatingScale
  readonly range: RatingRange
  readonly lower_label?: I18nText
  readonly upper_label?: I18nText
}

/** NPS (0–10), CSAT (1–5 faces) and CES (1–7): fixed scales with optional end labels. */
export interface ScoreQuestion extends QuestionBase {
  readonly type: 'nps' | 'csat' | 'ces'
  readonly lower_label?: I18nText
  readonly upper_label?: I18nText
}

export interface StatementQuestion extends QuestionBase {
  readonly type: 'statement'
  readonly cta?: { readonly label: I18nText; readonly url?: string }
}

export interface ConsentQuestion extends QuestionBase {
  readonly type: 'consent'
  readonly label: I18nText
}

export const CONTACT_FIELDS = ['name', 'email', 'phone', 'company'] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]
interface ContactFieldSetting {
  readonly show: boolean
  readonly required: boolean
}

export interface ContactQuestion extends QuestionBase {
  readonly type: 'contact_info'
  readonly fields: Readonly<Record<ContactField, ContactFieldSetting>>
}

export type Question =
  | OpenTextQuestion | ChoiceQuestion | RatingQuestion | ScoreQuestion
  | StatementQuestion | ConsentQuestion | ContactQuestion

export interface Ending {
  readonly id: string
  readonly title: I18nText
  readonly description?: I18nText
  readonly button?: { readonly label: I18nText; readonly url: string }
}

export interface HiddenField {
  readonly id: string
  readonly label?: string
}

export interface Welcome {
  readonly enabled: boolean
  readonly title: I18nText
  readonly description?: I18nText
  readonly button_label?: I18nText
}

export const TEST_RECORDS = ['tag', 'drop'] as const
export type TestRecord = (typeof TEST_RECORDS)[number]
interface TestSettings {
  readonly link_enabled: boolean
  readonly record: TestRecord
}

/** One palette of a form's theme: its primary (buttons, progress, the focus ring), background and text colours. */
export interface ThemePalette {
  readonly primary_color: string
  readonly background_color: string
  readonly text_color: string
}

export const THEME_MODES = ['light', 'dark', 'auto'] as const
/** Which palette respondents see: light, dark, or auto (their device's `prefers-color-scheme`). */
export type ThemeMode = (typeof THEME_MODES)[number]
/** System font stacks only (never a web font); `inherit` is the script embed's page font ("Same as your page"). */
export const THEME_FONTS = ['system', 'inherit', 'serif', 'rounded', 'mono'] as const
export type ThemeFont = (typeof THEME_FONTS)[number]
export const THEME_TEXT_SIZES = ['default', 'large'] as const
export type ThemeTextSize = (typeof THEME_TEXT_SIZES)[number]

/**
 * The customer's widget theme (data rendered on their page: the out-of-scope colours of the design system). The three
 * top-level colours are the LIGHT palette and `dark` the dark one (lambda/shared/form_theme.py, the same schema); the
 * editor always holds every field, a stored theme without the 7.55.01 ones read with their defaults.
 */
export interface FormTheme extends ThemePalette {
  readonly border_radius: string
  readonly mode: ThemeMode
  readonly dark: ThemePalette
  readonly font: ThemeFont
  readonly text_size: ThemeTextSize
}

/** Where a form is meant to run: the describe panel's `channel` and a template's "Runs". */
export const CHANNELS = ['link', 'embed', 'in_app'] as const
export type Channel = (typeof CHANNELS)[number]

/** A whole form as the editor holds it: the v2 content and the settings kept from v1. */
export interface FormV2 {
  readonly schema_version: 2
  readonly name: string
  readonly enabled: boolean
  readonly language: FormLanguage
  readonly languages: readonly FormLanguage[]
  readonly welcome: Welcome
  readonly questions: readonly Question[]
  readonly hidden_fields: readonly HiddenField[]
  readonly endings: readonly Ending[]
  readonly settings: { readonly test: TestSettings }
  readonly theme: FormTheme
  readonly category: string
  readonly subcategory: string
  readonly project_id: string
  readonly document_id: string
  readonly custom_fields: readonly unknown[]
  readonly dimension_defaults: Readonly<Record<string, string>>
  readonly tags: readonly string[]
  readonly form_type?: 'standard' | 'prototype_pin'
}

/** What the server says about a stored form beside its content. */
export interface StoredFormMeta {
  readonly form_id: string
  /** The revision this copy is; a save sends it as `expected_revision` (D7). */
  readonly revision: number
  /** How many saves the stored form has taken; a save sends it as `expected_write_count`, so any save since (an Enable,
   * a theme, not only a definition) is the stale-save conflict (D7). */
  readonly write_count: number
  /** The ids of the questions the form had and removed: never taken by a new question, a copy or a follow-up (the
   * server refuses a reused one, `question_id_reused`). */
  readonly retired_ids: readonly string[]
  readonly created_at: string
  readonly updated_at: string
  /** Who saved it last, when the server says (the conflict banner names them). */
  readonly updated_by: string
  /** Whether a real (not test) response exists: codes and ids lock from then on (D9). */
  readonly has_responses: boolean
  /** The real responses `GET /feedback-forms/{id}` counted (a save keeps the count it was opened with). */
  readonly response_count: number
  /** May this person delete the form's test responses (an admin, or its creator: the server's rule)? Read with the
   * form (`GET /feedback-forms/{id}`); a save keeps it. */
  readonly can_delete_test_responses: boolean
  /** The record was v1 and is shown migrated (saved as v2 on the next save). */
  readonly migrated_from_v1: boolean
  /** A v1 form whose language was '' (the visitor's browser): the primary must be confirmed (D15). */
  readonly language_unconfirmed: boolean
}

/** A form read from the server: its content and what the server says about it. */
export interface LoadedForm {
  readonly form: FormV2
  readonly meta: StoredFormMeta
}

/** VoC light: Kiro Light's accent, page background and strong text (theme/printPalette.ts, pinned to index.css). */
export const VOC_LIGHT_PALETTE: ThemePalette = {
  primary_color: KIRO_LIGHT_HEX.accent, background_color: KIRO_LIGHT_HEX.bg, text_color: KIRO_LIGHT_HEX.textStrong,
}
/** VoC dark: Kiro Dark's accent text, page and strong text (styles/theme-palettes.css; text 15.9:1, primary 7.27:1). */
export const VOC_DARK_PALETTE: ThemePalette = { primary_color: '#bd8fff', background_color: '#19161d', text_color: '#f2f1f4' }

/** A new form's theme, as the server's (form_theme.py `default_theme`): VoC light shown, VoC dark beside it. */
export const DEFAULT_THEME: FormTheme = {
  ...VOC_LIGHT_PALETTE, border_radius: '8px', mode: 'light', dark: VOC_DARK_PALETTE, font: 'system', text_size: 'default',
}

/** Is `value` one of the app's nine languages? */
export function isFormLanguage(value: unknown): value is FormLanguage {
  return typeof value === 'string' && FORM_LANGUAGES.some((language) => language === value)
}

export const isChoice = (question: Question): question is ChoiceQuestion =>
  question.type === 'single_select' || question.type === 'multi_select'

/** The types with a numeric scale: rating, NPS, CSAT and CES. */
export const isScale = (question: Question): question is RatingQuestion | ScoreQuestion =>
  question.type === 'rating' || question.type === 'nps' || question.type === 'csat' || question.type === 'ces'
