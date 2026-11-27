/**
 * @fileoverview How a change from the AI reads in the Improve sheet (UX §12.2): what it is ("question 2", "ending
 * “Dziękujemy”", "language English · 42 texts"), its headline, and each changed field's before → after in words
 * (texts in the primary language, options and a matrix's rows and columns by their labels, rules as sentences).
 *
 * @module pages/FeedbackForms/ai/changeText
 */
import type { TFunction } from 'i18next'
import { languageNames } from '../../../i18n/languages'
import type { FormV2, I18nText, Question, Rule } from '../model/formsV2'
import { isFormLanguage } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { ruleSentence } from '../logic/ruleSentence'
import { textsToTranslate } from '../model/translatable'
import type { FieldChange, FormChange } from '../model/formDiff'
import { isRecord } from '../../../lib/typeGuards'

/** The form a change's item is read from: the proposal, or (a removal) the form as it was. */
export const changeSource = (change: FormChange, before: FormV2, after: FormV2): FormV2 => (change.kind === 'removed' ? before : after)

export function questionOf(change: FormChange, before: FormV2, after: FormV2): Question | undefined {
  return change.area === 'question' ? changeSource(change, before, after).questions.find((q) => q.id === change.id) : undefined
}

/** The item's position (from 1) among the questions it is read from; null for anything but a question. */
export function numberOf(change: FormChange, before: FormV2, after: FormV2): number | null {
  if (change.area !== 'question') return null
  const index = changeSource(change, before, after).questions.findIndex((q) => q.id === change.id)
  return index === -1 ? null : index + 1
}

/** The item's own words: a question's headline, an ending's title, a language's name and how many texts it brings. */
export function headlineOf(t: TFunction<'feedbackForms'>, change: FormChange, before: FormV2, after: FormV2): string {
  const form = changeSource(change, before, after)
  switch (change.area) {
    case 'question': return textIn(questionOf(change, before, after)?.headline, form.language)
    case 'ending': return textIn(form.endings.find((e) => e.id === change.id)?.title, form.language)
    case 'hidden': return t('ai.diff.hidden', { id: change.id })
    case 'welcome': return t('ai.diff.welcome')
    case 'language': {
      const language = change.id
      if (!isFormLanguage(language)) return language
      if (change.kind !== 'added') return languageNames[language]
      const texts = textsToTranslate(after).filter((entry) => textIn(entry.text, language) !== '').length
      return `${languageNames[language]} · ${t('ai.diff.languageTexts', { count: texts })}`
    }
  }
}

/** "Apply: Added question 2" — the checkbox's name. */
export function applyLabel(t: TFunction<'feedbackForms'>, change: FormChange, before: FormV2, after: FormV2): string {
  const kind = t(`ai.diff.kinds.${change.kind}`)
  const form = changeSource(change, before, after)
  const what = (() => {
    switch (change.area) {
      case 'question': return t('ai.diff.what.question', { number: numberOf(change, before, after) ?? '' })
      case 'ending': return t('ai.diff.what.ending', { title: textIn(form.endings.find((e) => e.id === change.id)?.title, form.language) })
      case 'hidden': return t('ai.diff.what.hidden', { id: change.id })
      case 'language': return t('ai.diff.what.language', { language: isFormLanguage(change.id) ? languageNames[change.id] : change.id })
      case 'welcome': return t('ai.diff.what.welcome')
    }
  })()
  return t('ai.diff.apply', { kind, what })
}

const isTextValue = (value: unknown): value is I18nText =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

const changedOptionLabels = (value: unknown, form: FormV2): string | null => {
  if (!Array.isArray(value)) return null
  const labels = value.map((option: unknown) => (typeof option === 'object' && option !== null && 'label' in option && isTextValue(option.label)
    ? textIn(option.label, form.language) : ''))
  return labels.join(' · ')
}

/** The fields that are lists of labelled entries: a choice's options, a matrix's rows and columns. */
const LABELLED_LISTS: ReadonlySet<string> = new Set(['options', 'rows', 'columns'])

const yesNo = (t: TFunction<'feedbackForms'>, value: boolean): string => (value ? t('ai.diff.values.yes') : t('ai.diff.values.no'))

/** An object field (Other, None, a link button, an ending's button): its label and address, or whether it is on. */
function objectText(t: TFunction<'feedbackForms'>, form: FormV2, value: object): string {
  if ('label' in value && isTextValue(value.label)) {
    const url = 'url' in value && typeof value.url === 'string' ? ` (${value.url})` : ''
    const label = 'enabled' in value && value.enabled === false ? t('ai.diff.values.no') : textIn(value.label, form.language)
    return `${label}${url}`
  }
  if ('enabled' in value) return yesNo(t, value.enabled === true)
  return JSON.stringify(value)
}

/** A field's value as words (the sheet's before → after). */
export function valueText(t: TFunction<'feedbackForms'>, form: FormV2, value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return t('ai.diff.values.empty')
  if (typeof value === 'boolean') return yesNo(t, value)
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (isTextValue(value)) return textIn(value, form.language) || t('ai.diff.values.empty')
  if (LABELLED_LISTS.has(field)) return changedOptionLabels(value, form) ?? ''
  return typeof value === 'object' ? objectText(t, form, value) : t('ai.diff.values.empty')
}

const asRules = (value: unknown): Rule[] => (Array.isArray(value)
  ? value.filter((rule: unknown): rule is Rule => typeof rule === 'object' && rule !== null && 'when' in rule && 'then' in rule) : [])

/** A logic change as the rules it adds and removes, each a sentence. */
export function ruleLines(t: TFunction<'feedbackForms'>, field: FieldChange, change: FormChange, before: FormV2, after: FormV2): string[] {
  const was = before.questions.find((q) => q.id === change.id)
  const now = after.questions.find((q) => q.id === change.id)
  const old = asRules(field.before)
  const fresh = asRules(field.after)
  const key = (rule: Rule) => JSON.stringify(rule)
  const added = now === undefined ? [] : fresh.filter((rule) => !old.some((o) => key(o) === key(rule)))
    .map((rule) => t('ai.diff.ruleAdded', { sentence: ruleSentence(t, after, now, rule) }))
  const removed = was === undefined ? [] : old.filter((rule) => !fresh.some((f) => key(f) === key(rule)))
    .map((rule) => t('ai.diff.ruleRemoved', { sentence: ruleSentence(t, before, was, rule) }))
  return [...added, ...removed]
}

/** A field's name ("Question", "Options", "Logic"), or the field itself when it has none. */
export function fieldName(t: TFunction<'feedbackForms'>, field: string): string {
  const key = `ai.diff.fields.${field}`
  const name = t(key)
  return name === key ? field : name
}
