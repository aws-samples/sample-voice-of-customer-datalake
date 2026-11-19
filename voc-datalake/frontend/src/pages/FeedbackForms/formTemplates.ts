/**
 * @fileoverview The twelve templates (UX §2.4), grouped by goal, and the form each one makes in a language.
 *
 * Each template is a real v2 flow (`templates/*Templates.ts`: ids, types, codes, display, shuffle, min and max,
 * logic, endings, hidden fields) whose copy is in the catalogue under `templates.<id>.…` in the nine locales. A form
 * made from one has every text in the "Create in" language, the default theme, no category, and is Off and unsaved
 * until its first Save (UX §2.1). Adding a language later fills each text still equal to the template's from that
 * language's catalogue (`fillFromTemplate`, UX §8).
 *
 * @module pages/FeedbackForms/formTemplates
 */
import type { ChoiceQuestion, Ending, FormLanguage, FormV2, I18nText, Question, Welcome } from './model/formsV2'
import { newFormSettings } from './model/defaults'
import { textIn, textOf } from './model/i18nText'
import { translatableTexts } from './model/translatable'
import type { TemplateFlow } from './templates/templateKit'
import { LOYALTY_TEMPLATES } from './templates/loyaltyTemplates'
import { DROPOFF_TEMPLATES } from './templates/dropoffTemplates'
import { BLANK_TEMPLATES, ONBOARDING_TEMPLATES, PRODUCT_TEMPLATES } from './templates/productTemplates'

/** Every template in the picker's order: Loyalty, Drop-offs, Product, Onboarding, Blank. */
export const FORM_TEMPLATES: readonly TemplateFlow[] = [
  ...LOYALTY_TEMPLATES, ...DROPOFF_TEMPLATES, ...PRODUCT_TEMPLATES, ...ONBOARDING_TEMPLATES, ...BLANK_TEMPLATES,
]

export const templateById = (id: string): TemplateFlow | undefined => FORM_TEMPLATES.find((flow) => flow.id === id)

/** A catalogue lookup in one language: the text of a `feedbackForms` key, or undefined when the key has none. */
export type CopyLookup = (key: string) => string | undefined

function filled(lookup: CopyLookup, key: string, language: FormLanguage): I18nText | undefined {
  const value = lookup(key)
  return value === undefined || value === '' ? undefined : textOf(language, value)
}

type TextOf = (key: string) => I18nText | undefined

function choiceCopy(question: ChoiceQuestion, text: TextOf): ChoiceQuestion {
  return {
    ...question,
    options: question.options.map((option) => ({ ...option, label: text(`options.${option.code}`) ?? {} })),
    other: { ...question.other, label: text('other'), placeholder: text('otherPlaceholder') },
    none: { ...question.none, label: text('none') },
  }
}

function questionCopy(question: Question, prefix: string, language: FormLanguage, lookup: CopyLookup): Question {
  const text: TextOf = (key) => filled(lookup, `${prefix}.${key}`, language)
  const required = (key: string): I18nText => text(key) ?? {}
  const base = { ...question, headline: required('headline'), subheader: text('subheader'), button_label: text('button') }
  switch (base.type) {
    case 'single_select': case 'multi_select': return choiceCopy(base, text)
    case 'open_text': return { ...base, placeholder: text('placeholder') }
    case 'rating': case 'nps': case 'csat': case 'ces': return { ...base, lower_label: text('lower'), upper_label: text('upper') }
    case 'consent': return { ...base, label: required('label') }
    case 'statement': case 'contact_info': return base
  }
}

function welcomeCopy(flow: TemplateFlow, language: FormLanguage, lookup: CopyLookup): Welcome {
  const text = (key: string) => filled(lookup, `templates.${flow.id}.welcome.${key}`, language)
  if (!flow.welcome) return { enabled: false, title: {} }
  return { enabled: true, title: text('title') ?? {}, description: text('description'), button_label: text('button') }
}

function endingCopy(flow: TemplateFlow, id: string, language: FormLanguage, lookup: CopyLookup): Ending {
  const text = (key: string) => filled(lookup, `templates.${flow.id}.endings.${id}.${key}`, language)
  return { id, title: text('title') ?? {}, description: text('description') }
}

/** The form a template makes in `language` (its copy from `lookup`, that language's catalogue). */
export function templateForm(flow: TemplateFlow, language: FormLanguage, lookup: CopyLookup): FormV2 {
  return {
    schema_version: 2,
    name: lookup(`templates.${flow.id}.name`) ?? flow.id,
    enabled: false,
    language,
    languages: [language],
    welcome: welcomeCopy(flow, language, lookup),
    questions: flow.questions.map((question) => questionCopy(question, `templates.${flow.id}.q.${question.id}`, language, lookup)),
    hidden_fields: flow.hidden.map((field) => {
      const label = field.labelled === true ? lookup(`templates.${flow.id}.hidden.${field.id}`) : undefined
      return label === undefined ? { id: field.id } : { id: field.id, label }
    }),
    endings: flow.endings.map((id) => endingCopy(flow, id, language, lookup)),
    ...newFormSettings(),
  }
}

/**
 * Fill `language` in `form` from the template's catalogue wherever the primary text still equals the template's
 * (UX §8): returns the form and the keys of the texts it filled (shown "From template" until edited).
 */
export function fillFromTemplate(form: FormV2, flow: TemplateFlow, language: FormLanguage, primaryLookup: CopyLookup, lookup: CopyLookup): { form: FormV2; filled: string[] } {
  const original = new Map(translatableTexts(templateForm(flow, form.language, primaryLookup)).map((entry) => [entry.key, textIn(entry.text, form.language)]))
  const translated = new Map(translatableTexts(templateForm(flow, language, lookup)).map((entry) => [entry.key, textIn(entry.text, language)]))
  const keys: string[] = []
  const next = translatableTexts(form).reduce((current, entry) => {
    const primary = textIn(entry.text, form.language)
    const value = translated.get(entry.key) ?? ''
    if (primary === '' || value === '' || original.get(entry.key) !== primary || textIn(entry.text, language) !== '') return current
    keys.push(entry.key)
    return entry.write(current, language, value)
  }, form)
  return { form: next, filled: keys }
}
