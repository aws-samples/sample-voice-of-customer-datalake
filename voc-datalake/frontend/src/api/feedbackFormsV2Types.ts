/**
 * @fileoverview The public widget config of a Feedback Form, schema version 2 (7.55.00): `FeedbackFormConfig`, the
 * body of the UNAUTHENTICATED `GET /feedback-forms/{id}/config` that the widget reads on customers' own websites.
 * Nothing imports it: it is the wire shape lambda/api/test/test_widget_config_type_lockstep.py holds against the
 * handler's `item_to_widget_config`, and feedbackFormTypes.test.ts keeps the validation links off it. The builder's
 * own model of a form is pages/FeedbackForms/model/formsV2.ts; the API's other shapes are in docs/feedback-forms.md
 * and api/feedbackFormsV2Api.ts.
 *
 * @module api/feedbackFormsV2Types
 */
/**
 * Feedback Forms, schema version 2 (docs/feedback-forms.md "Schema v2"; the server's one definition is
 * lambda/shared/forms_v2.py). `FormLocale` is one of the app's nine; an `I18nText` holds the primary locale's text
 * (required) and any translations (others fall back to the primary).
 */
type FormLocale = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'zh' | 'ko' | 'pl'
type I18nText = Partial<Record<FormLocale, string>>
type FormQuestionType =
  | 'open_text' | 'single_select' | 'multi_select' | 'rating' | 'nps' | 'csat' | 'ces'
  | 'statement' | 'consent' | 'contact_info'
type FormRuleOp =
  | 'equals' | 'not_equals' | 'includes_any' | 'includes_all' | 'lt' | 'lte' | 'gt' | 'gte' | 'submitted' | 'skipped'

/** First matching rule wins; `jump_to` is a LATER question id or an ending id. */
interface FormRule {
  when: { op: FormRuleOp; value?: string | number | string[] }
  then: { jump_to: string }
}

/** `code` matches `^[a-z0-9_]{1,40}$`; `other` and `none` are reserved while the question enables them. */
interface FormOption {
  code: string
  label: I18nText
  /** Routing: never in the public config. */
  category?: { category: string; subcategory?: string }
}

type FormContactField = 'name' | 'email' | 'phone' | 'company'

/** One question; the per-type fields are present only on their type (the server refuses any other key). */
interface FormQuestion {
  /** `^q_[a-z0-9_]{1,40}$`, stable, never reused within the form. */
  id: string
  type: FormQuestionType
  headline: I18nText
  subheader?: I18nText
  required: boolean
  button_label?: I18nText
  logic?: FormRule[]
  // open_text
  long?: boolean
  input_type?: 'text' | 'email' | 'number' | 'phone' | 'url'
  placeholder?: I18nText
  max_chars?: number
  // single_select / multi_select
  options?: FormOption[]
  other?: { enabled: boolean; label?: I18nText; placeholder?: I18nText }
  none?: { enabled: boolean; label?: I18nText }
  shuffle?: 'none' | 'all' | 'except_last'
  display?: 'auto' | 'list' | 'dropdown' | 'chips'
  min?: number
  max?: number
  // rating (nps / csat / ces take only the two labels)
  scale?: 'star' | 'number' | 'smiley'
  range?: 3 | 4 | 5 | 7 | 10
  lower_label?: I18nText
  upper_label?: I18nText
  // statement / consent / contact_info
  cta?: { label: I18nText; url?: string }
  label?: I18nText
  fields?: Record<FormContactField, { show: boolean; required: boolean }>
}

interface FormWelcome {
  enabled: boolean
  title?: I18nText
  description?: I18nText
  button_label?: I18nText
}

interface FormEnding {
  /** `^end_[a-z0-9_]{1,40}$`. */
  id: string
  title: I18nText
  description?: I18nText
  button?: { label: I18nText; url: string }
}

/**
 * The PUBLIC widget config (`GET /feedback-forms/{id}/config`, unauthenticated, fetched from customers' sites):
 * schema version 2, only what the widget renders. Never the internal name, the routing (option categories), the
 * links, the labels or the test settings. Mirrors `item_to_widget_config` in lambda/api/feedback_form_handler.py
 * (lambda/api/test/test_widget_config_type_lockstep.py reads this declaration).
 */
export interface FeedbackFormConfig {
  enabled: boolean
  schema_version: 2
  revision: number
  language: FormLocale
  languages: FormLocale[]
  welcome: FormWelcome
  questions: FormQuestion[]
  hidden_fields: Array<{ id: string }>
  endings: FormEnding[]
  /** A version 1 form without a language, migrated to the deployment's: the widget keeps the browser's for its words. */
  language_assumed: boolean
  theme: {
    primary_color?: string
    background_color?: string
    text_color?: string
    border_radius?: string
  }
}
