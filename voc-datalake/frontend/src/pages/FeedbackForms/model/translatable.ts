/**
 * @fileoverview Every text of a form a translator writes (UX §8): one entry per field, in form order (the questions,
 * then the welcome card, then the endings), with a setter that writes one language of it.
 *
 * A text is "missing" in a language when the primary has it and that language does not. Required texts (a headline,
 * an option, an ending's title, a consent's checkbox text, an enabled welcome's title) also count toward a question
 * card's "en missing" badge; optional ones count only where the primary has them.
 *
 * @module pages/FeedbackForms/model/translatable
 */
import type { ChoiceQuestion, Ending, FormLanguage, FormV2, I18nText, Question, Welcome } from './formsV2'
import { isChoice, isScale } from './formsV2'
import { hasText, withText } from './i18nText'

/** The field a text is, as the translation table names it (`languages.fields.<field>`). */
type TextField =
  | 'headline' | 'subheader' | 'placeholder' | 'buttonLabel' | 'option' | 'otherLabel' | 'otherPlaceholder'
  | 'noneLabel' | 'lowerLabel' | 'upperLabel' | 'consentLabel' | 'ctaLabel'
  | 'welcomeTitle' | 'welcomeDescription' | 'welcomeButton' | 'endingTitle' | 'endingDescription' | 'endingButton'

export interface TranslatableText {
  /** A stable key for the row (`q_reason.option.too_expensive`). */
  readonly key: string
  /** Whose text: a question, the welcome card, or an ending. */
  readonly owner: { readonly kind: 'question' | 'welcome' | 'ending'; readonly id: string }
  readonly field: TextField
  /** The option's position (from 1), for "Option 3". */
  readonly number?: number
  readonly text: I18nText | undefined
  readonly required: boolean
  /** The form with this text's `language` entry set to `value`. */
  readonly write: (form: FormV2, language: FormLanguage, value: string) => FormV2
}

type QuestionPatch = (question: Question, language: FormLanguage, value: string) => Question

function questionText(question: Question, field: TextField, text: I18nText | undefined, required: boolean, patch: QuestionPatch, number?: number): TranslatableText {
  return {
    key: [question.id, field, ...(number === undefined ? [] : [String(number)])].join('.'),
    owner: { kind: 'question', id: question.id },
    field, number, text, required,
    write: (form, language, value) => ({
      ...form,
      questions: form.questions.map((q) => (q.id === question.id ? patch(q, language, value) : q)),
    }),
  }
}

function choiceTexts(question: ChoiceQuestion): TranslatableText[] {
  const patchChoice = (fn: (q: ChoiceQuestion, language: FormLanguage, value: string) => ChoiceQuestion): QuestionPatch =>
    (q, language, value) => (isChoice(q) ? fn(q, language, value) : q)
  const options = question.options.map((option, index) => questionText(question, 'option', option.label, true,
    patchChoice((q, language, value) => ({
      ...q, options: q.options.map((o) => (o.code === option.code ? { ...o, label: withText(o.label, language, value) } : o)),
    })), index + 1))
  const other = question.other.enabled ? [
    questionText(question, 'otherLabel', question.other.label, false,
      patchChoice((q, language, value) => ({ ...q, other: { ...q.other, label: withText(q.other.label, language, value) } }))),
    questionText(question, 'otherPlaceholder', question.other.placeholder, false,
      patchChoice((q, language, value) => ({ ...q, other: { ...q.other, placeholder: withText(q.other.placeholder, language, value) } }))),
  ] : []
  const none = question.type === 'multi_select' && question.none.enabled ? [
    questionText(question, 'noneLabel', question.none.label, false,
      patchChoice((q, language, value) => ({ ...q, none: { ...q.none, label: withText(q.none.label, language, value) } }))),
  ] : []
  return [...options, ...other, ...none]
}

function ownTexts(question: Question): TranslatableText[] {
  switch (question.type) {
    case 'single_select': case 'multi_select': return choiceTexts(question)
    case 'open_text': return [questionText(question, 'placeholder', question.placeholder, false,
      (q, language, value) => (q.type === 'open_text' ? { ...q, placeholder: withText(q.placeholder, language, value) } : q))]
    case 'rating': case 'nps': case 'csat': case 'ces': return [
      questionText(question, 'lowerLabel', question.lower_label, false,
        (q, language, value) => (isScale(q) ? { ...q, lower_label: withText(q.lower_label, language, value) } : q)),
      questionText(question, 'upperLabel', question.upper_label, false,
        (q, language, value) => (isScale(q) ? { ...q, upper_label: withText(q.upper_label, language, value) } : q)),
    ]
    case 'consent': return [questionText(question, 'consentLabel', question.label, true,
      (q, language, value) => (q.type === 'consent' ? { ...q, label: withText(q.label, language, value) } : q))]
    case 'statement': return question.cta === undefined ? [] : [questionText(question, 'ctaLabel', question.cta.label, false,
      (q, language, value) => (q.type === 'statement' && q.cta !== undefined ? { ...q, cta: { ...q.cta, label: withText(q.cta.label, language, value) } } : q))]
    case 'contact_info': return []
  }
}

function questionTexts(question: Question): TranslatableText[] {
  return [
    questionText(question, 'headline', question.headline, true, (q, language, value) => ({ ...q, headline: withText(q.headline, language, value) })),
    questionText(question, 'subheader', question.subheader, false, (q, language, value) => ({ ...q, subheader: withText(q.subheader, language, value) })),
    ...ownTexts(question),
    questionText(question, 'buttonLabel', question.button_label, false, (q, language, value) => ({ ...q, button_label: withText(q.button_label, language, value) })),
  ]
}

function welcomeTexts(welcome: Welcome): TranslatableText[] {
  if (!welcome.enabled) return []
  const entry = (field: TextField, text: I18nText | undefined, required: boolean, patch: (w: Welcome, language: FormLanguage, value: string) => Welcome): TranslatableText => ({
    key: `welcome.${field}`, owner: { kind: 'welcome', id: 'welcome' }, field, text, required,
    write: (form, language, value) => ({ ...form, welcome: patch(form.welcome, language, value) }),
  })
  return [
    entry('welcomeTitle', welcome.title, true, (w, language, value) => ({ ...w, title: withText(w.title, language, value) })),
    entry('welcomeDescription', welcome.description, false, (w, language, value) => ({ ...w, description: withText(w.description, language, value) })),
    entry('welcomeButton', welcome.button_label, false, (w, language, value) => ({ ...w, button_label: withText(w.button_label, language, value) })),
  ]
}

function endingTexts(ending: Ending): TranslatableText[] {
  const entry = (field: TextField, text: I18nText | undefined, required: boolean, patch: (e: Ending, language: FormLanguage, value: string) => Ending): TranslatableText => ({
    key: `${ending.id}.${field}`, owner: { kind: 'ending', id: ending.id }, field, text, required,
    write: (form, language, value) => ({ ...form, endings: form.endings.map((e) => (e.id === ending.id ? patch(e, language, value) : e)) }),
  })
  const button = ending.button === undefined ? [] : [entry('endingButton', ending.button.label, false,
    (e, language, value) => (e.button === undefined ? e : { ...e, button: { ...e.button, label: withText(e.button.label, language, value) } }))]
  return [
    entry('endingTitle', ending.title, true, (e, language, value) => ({ ...e, title: withText(e.title, language, value) })),
    entry('endingDescription', ending.description, false, (e, language, value) => ({ ...e, description: withText(e.description, language, value) })),
    ...button,
  ]
}

/** Every text of the form, in form order. */
export function translatableTexts(form: FormV2): TranslatableText[] {
  return [...form.questions.flatMap(questionTexts), ...welcomeTexts(form.welcome), ...form.endings.flatMap(endingTexts)]
}

/** The texts a translation into `language` has to cover: those the primary has. */
export function textsToTranslate(form: FormV2): TranslatableText[] {
  return translatableTexts(form).filter((entry) => hasText(entry.text, form.language))
}

/** The texts missing in `language` (the primary has them, `language` does not). */
export function missingTexts(form: FormV2, language: FormLanguage): TranslatableText[] {
  if (language === form.language) return []
  return textsToTranslate(form).filter((entry) => !hasText(entry.text, language))
}

/** The languages (not the primary) in which `owner` misses a required text: the card's "en missing" badges. */
export function missingLanguagesOf(form: FormV2, ownerId: string): FormLanguage[] {
  const owned = textsToTranslate(form).filter((entry) => entry.owner.id === ownerId && entry.required)
  return form.languages.filter((language) => language !== form.language && owned.some((entry) => !hasText(entry.text, language)))
}
