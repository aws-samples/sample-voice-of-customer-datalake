/**
 * @fileoverview The edits the builder makes to a form, as pure functions (form in, form out). Removing a question or
 * an ending also removes the rules that jumped to it (those respondents go to the next question, or see the default
 * ending: UX §3.3, §7); renaming an id or a code rewrites the rules that name it. Nothing here validates: the
 * problems list (validateForm.ts) says what a change left wrong.
 *
 * @module pages/FeedbackForms/model/mutations
 */
import type { ChoiceQuestion, Ending, FormLanguage, FormV2, I18nText, Question, Rule } from './formsV2'
import { isChoice } from './formsV2'
import { duplicateId } from './codes'
import { keepLanguages } from './i18nText'
import { splitOtherwise, valueCodes, withLogic } from './rules'

/** `items` with the one at `from` moved to `to` (clamped). */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const item = items[from]
  if (item === undefined) return [...items]
  const rest = items.filter((_item, index) => index !== from)
  const at = Math.max(0, Math.min(to, rest.length))
  return [...rest.slice(0, at), item, ...rest.slice(at)]
}

export const questionIds = (form: FormV2): Set<string> => new Set(form.questions.map((q) => q.id))
export const endingIds = (form: FormV2): Set<string> => new Set(form.endings.map((e) => e.id))

export function updateQuestion(form: FormV2, id: string, fn: (question: Question) => Question): FormV2 {
  return { ...form, questions: form.questions.map((q) => (q.id === id ? fn(q) : q)) }
}

export function updateChoice(form: FormV2, id: string, fn: (question: ChoiceQuestion) => ChoiceQuestion): FormV2 {
  return updateQuestion(form, id, (q) => (isChoice(q) ? fn(q) : q))
}

export function insertQuestion(form: FormV2, question: Question, at: number): FormV2 {
  const index = Math.max(0, Math.min(at, form.questions.length))
  return { ...form, questions: [...form.questions.slice(0, index), question, ...form.questions.slice(index)] }
}

export function moveQuestion(form: FormV2, id: string, to: number): FormV2 {
  return { ...form, questions: moved(form.questions, form.questions.findIndex((q) => q.id === id), to) }
}

/** Every question's logic with `fn` applied to its own rules and its Otherwise (as split by `splitOtherwise`). */
function mapLogic(form: FormV2, fn: (rules: readonly Rule[], otherwise: string | null) => { rules: readonly Rule[]; otherwise: string | null }): FormV2 {
  return {
    ...form,
    questions: form.questions.map((q) => {
      if (q.logic === undefined || q.logic.length === 0) return q
      const split = splitOtherwise(q)
      const next = fn(split.rules, split.otherwise)
      return withLogic(q, next.rules, next.otherwise)
    }),
  }
}

/** How many rules (Otherwise included) jump to `target`. */
export function rulesTargeting(form: FormV2, target: string): number {
  return form.questions.reduce((sum, q) => {
    const split = splitOtherwise(q)
    return sum + split.rules.filter((rule) => rule.then.jump_to === target).length + (split.otherwise === target ? 1 : 0)
  }, 0)
}

/** The form without the rules (and Otherwise) that jump to `target`. */
export function withoutRulesTo(form: FormV2, target: string): FormV2 {
  return mapLogic(form, (rules, otherwise) => ({
    rules: rules.filter((rule) => rule.then.jump_to !== target),
    otherwise: otherwise === target ? null : otherwise,
  }))
}

/** The form with every jump to `from` going to `to` instead. */
function retarget(form: FormV2, from: string, to: string): FormV2 {
  return mapLogic(form, (rules, otherwise) => ({
    rules: rules.map((rule) => (rule.then.jump_to === from ? { ...rule, then: { jump_to: to } } : rule)),
    otherwise: otherwise === from ? to : otherwise,
  }))
}

/** Remove a question and the rules that jumped to it. */
export function removeQuestion(form: FormV2, id: string): FormV2 {
  const cleaned = withoutRulesTo(form, id)
  return { ...cleaned, questions: cleaned.questions.filter((q) => q.id !== id) }
}

/** A copy right after the original, with the id `<id>_2`, its rules and its options (same codes): UX §3.3. */
export function duplicateQuestion(form: FormV2, id: string): { form: FormV2; copyId: string | null } {
  const index = form.questions.findIndex((q) => q.id === id)
  const original = form.questions[index]
  if (original === undefined) return { form, copyId: null }
  const copyId = duplicateId(original.id, questionIds(form))
  return { form: insertQuestion(form, { ...original, id: copyId }, index + 1), copyId }
}

/** Rename a question's id, and every rule that jumps to it. */
export function renameQuestionId(form: FormV2, from: string, to: string): FormV2 {
  const renamed = retarget(form, from, to)
  return { ...renamed, questions: renamed.questions.map((q) => (q.id === from ? { ...q, id: to } : q)) }
}

export function updateEnding(form: FormV2, id: string, fn: (ending: Ending) => Ending): FormV2 {
  return { ...form, endings: form.endings.map((e) => (e.id === id ? fn(e) : e)) }
}

export function insertEnding(form: FormV2, ending: Ending): FormV2 {
  return { ...form, endings: [...form.endings, ending] }
}

export function moveEnding(form: FormV2, id: string, to: number): FormV2 {
  return { ...form, endings: moved(form.endings, form.endings.findIndex((e) => e.id === id), to) }
}

/** Remove an ending and the rules that ended there (those respondents see the default ending). */
export function removeEnding(form: FormV2, id: string): FormV2 {
  const cleaned = withoutRulesTo(form, id)
  return { ...cleaned, endings: cleaned.endings.filter((e) => e.id !== id) }
}

export function renameEndingId(form: FormV2, from: string, to: string): FormV2 {
  const renamed = retarget(form, from, to)
  return { ...renamed, endings: renamed.endings.map((e) => (e.id === from ? { ...e, id: to } : e)) }
}

/** Rename an option's code on a question, and every rule value on that question that names it. */
export function renameOptionCode(form: FormV2, questionId: string, from: string, to: string): FormV2 {
  return updateQuestion(form, questionId, (q) => {
    if (!isChoice(q)) return q
    const logic = q.logic?.map((rule) => {
      const value = rule.when.value
      if (typeof value === 'string') return value === from ? { ...rule, when: { ...rule.when, value: to } } : rule
      if (!Array.isArray(value)) return rule
      return { ...rule, when: { ...rule.when, value: valueCodes(value).map((code) => (code === from ? to : code)) } }
    })
    return { ...q, logic, options: q.options.map((o) => (o.code === from ? { ...o, code: to } : o)) }
  })
}

/** Keep only the entries of the form's languages in every text (after a language is removed). */
function stripLanguages(question: Question, keep: readonly FormLanguage[]): Question {
  return mapTexts(question, (text) => keepLanguages(text, keep) ?? {})
}

type TextMap = (text: I18nText) => I18nText

/** `question` with `fn` applied to every one of its texts. */
function mapTexts(question: Question, fn: TextMap): Question {
  const t = (text: I18nText | undefined) => (text === undefined ? undefined : fn(text))
  const base = { ...question, headline: fn(question.headline), subheader: t(question.subheader), button_label: t(question.button_label) }
  switch (base.type) {
    case 'single_select': case 'multi_select':
      return {
        ...base,
        options: base.options.map((o) => ({ ...o, label: fn(o.label) })),
        other: { ...base.other, label: t(base.other.label), placeholder: t(base.other.placeholder) },
        none: { ...base.none, label: t(base.none.label) },
      }
    case 'open_text': return { ...base, placeholder: t(base.placeholder) }
    case 'rating': case 'nps': case 'csat': case 'ces': return { ...base, lower_label: t(base.lower_label), upper_label: t(base.upper_label) }
    case 'consent': return { ...base, label: fn(base.label) }
    case 'statement': return { ...base, cta: base.cta === undefined ? undefined : { ...base.cta, label: fn(base.cta.label) } }
    case 'contact_info': return base
  }
}

export function addLanguage(form: FormV2, language: FormLanguage): FormV2 {
  return form.languages.includes(language) ? form : { ...form, languages: [...form.languages, language] }
}

/** Remove a translation: the language and its texts go (the primary cannot be removed). */
export function removeLanguage(form: FormV2, language: FormLanguage): FormV2 {
  if (language === form.language) return form
  const keep = form.languages.filter((lng) => lng !== language)
  const k = (text: I18nText | undefined) => keepLanguages(text, keep)
  return {
    ...form,
    languages: keep,
    questions: form.questions.map((q) => stripLanguages(q, keep)),
    welcome: { ...form.welcome, title: k(form.welcome.title) ?? {}, description: k(form.welcome.description), button_label: k(form.welcome.button_label) },
    endings: form.endings.map((e) => ({
      ...e, title: k(e.title) ?? {}, description: k(e.description),
      button: e.button === undefined ? undefined : { ...e.button, label: k(e.button.label) ?? {} },
    })),
  }
}

/** Make `language` the primary (it swaps roles with the old one; no text is lost, codes and ids never change). */
export function setPrimaryLanguage(form: FormV2, language: FormLanguage): FormV2 {
  const languages = [language, ...form.languages.filter((lng) => lng !== language)]
  return { ...form, language, languages }
}
