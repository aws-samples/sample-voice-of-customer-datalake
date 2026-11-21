/**
 * @fileoverview What the AI changed in a form (UX §12.2), keyed by id (the Documents section's `structured` diff idea):
 * each question, ending, hidden field and language is Added, Removed or Changed, and the welcome card Changed. A
 * changed question lists its changed fields (before → after); the texts of a language the AI added count toward that
 * language, not toward every question.
 *
 * Only questions, logic, endings, hidden fields, languages and the welcome card may change: anything else the AI
 * changed (the name, the theme, the category routing, the linked project, the test settings, tags, dimensions) is
 * listed as ignored and never applied. `applyChanges` (formDiffApply.ts) builds the form from the accepted changes.
 *
 * @module pages/FeedbackForms/model/formDiff
 */
import type { Ending, FormLanguage, FormV2, HiddenField, I18nText, Question, Welcome } from './formsV2'
import { keepLanguages } from './i18nText'
import type { ProblemLocation } from './validateForm'
import { isRecord } from '../../../lib/typeGuards'
import { sameJson } from '../../../lib/sameJson'

type ChangeKind = 'added' | 'removed' | 'changed'
type ChangeArea = 'question' | 'ending' | 'hidden' | 'language' | 'welcome'

/** One field of a changed item, before and after (raw values; the sheet words them). */
export interface FieldChange {
  readonly field: string
  readonly before: unknown
  readonly after: unknown
}

/** An https address a change brings in: it applies only once the person has checked it. */
interface SuggestedAddress {
  readonly location: ProblemLocation
  readonly url: string
}

export interface FormChange {
  /** `question:q_x`, `ending:end_x`, `hidden:user_id`, `language:en`, `welcome`. */
  readonly key: string
  readonly area: ChangeArea
  readonly kind: ChangeKind
  readonly id: string
  readonly fields: readonly FieldChange[]
  readonly addresses: readonly SuggestedAddress[]
}

/** What the AI may not change here: listed as "Ignored: …", never applied. */
const IGNORED_AREAS = ['name', 'theme', 'routing', 'project', 'test', 'tags', 'dimensions'] as const
type IgnoredArea = (typeof IGNORED_AREAS)[number]

export interface FormDiff {
  readonly changes: readonly FormChange[]
  readonly ignored: readonly IgnoredArea[]
}

const same = (a: unknown, b: unknown): boolean => sameJson(a ?? null, b ?? null)

const isText = (value: unknown): value is I18nText =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

const TEXT_KEYS: ReadonlySet<string> = new Set([
  'headline', 'subheader', 'button_label', 'placeholder', 'lower_label', 'upper_label', 'label', 'title', 'description',
])

/** A text kept to `languages`, without empty entries; undefined when nothing is left. */
function restrictedText(value: I18nText, languages: readonly FormLanguage[]): I18nText | undefined {
  const kept = Object.entries(keepLanguages(value, languages) ?? {}).filter(([, text]) => text !== '')
  return kept.length === 0 ? undefined : Object.fromEntries(kept)
}

/** A value with every text kept to `languages` (and empty ones dropped), so new translations don't read as edits. */
function restricted(value: unknown, languages: readonly FormLanguage[], key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => restricted(item, languages))
  if (typeof value !== 'object' || value === null) return value
  if (TEXT_KEYS.has(key) && isText(value)) return restrictedText(value, languages)
  return Object.fromEntries(Object.entries(value)
    .map(([name, entry]) => [name, restricted(entry, languages, name)] as const)
    .filter(([, entry]) => entry !== undefined))
}

/** The fields of `before` and `after` that differ (texts compared in `languages` only). */
function changedKeys(before: object, after: object, languages: readonly FormLanguage[]): FieldChange[] {
  const a = restricted(before, languages)
  const b = restricted(after, languages)
  const left: Record<string, unknown> = typeof a === 'object' && a !== null ? { ...a } : {}
  const right: Record<string, unknown> = typeof b === 'object' && b !== null ? { ...b } : {}
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => key !== 'id')
  return keys.filter((key) => !same(left[key], right[key])).map((field) => ({ field, before: left[field], after: right[field] }))
}

function questionAddresses(question: Question): SuggestedAddress[] {
  if (question.type !== 'statement' || question.cta?.url === undefined || question.cta.url === '') return []
  return [{ location: { kind: 'question', id: question.id, field: 'cta_url' }, url: question.cta.url }]
}

function endingAddresses(ending: Ending): SuggestedAddress[] {
  return ending.button === undefined ? [] : [{ location: { kind: 'ending', id: ending.id, field: 'button_url' }, url: ending.button.url }]
}

/** The addresses an item brings in that the base did not have at the same place. */
function newAddresses(base: readonly SuggestedAddress[], next: readonly SuggestedAddress[]): SuggestedAddress[] {
  return next.filter((address) => !base.some((old) => old.url === address.url))
}

interface Keyed {
  readonly id: string
}

function keyedChanges<T extends Keyed>(area: ChangeArea, before: readonly T[], after: readonly T[], languages: readonly FormLanguage[], addresses: (item: T) => SuggestedAddress[]): FormChange[] {
  const old = new Map(before.map((item) => [item.id, item]))
  const fresh = new Map(after.map((item) => [item.id, item]))
  const kept = after.flatMap((item): FormChange[] => {
    const was = old.get(item.id)
    if (was === undefined) return [{ key: `${area}:${item.id}`, area, kind: 'added', id: item.id, fields: [], addresses: addresses(item) }]
    const fields = changedKeys(was, item, languages)
    if (fields.length === 0) return []
    return [{ key: `${area}:${item.id}`, area, kind: 'changed', id: item.id, fields, addresses: newAddresses(addresses(was), addresses(item)) }]
  })
  const removed = before.filter((item) => !fresh.has(item.id))
    .map((item): FormChange => ({ key: `${area}:${item.id}`, area, kind: 'removed', id: item.id, fields: [], addresses: [] }))
  return [...kept, ...removed]
}

function languageChanges(before: FormV2, after: FormV2): FormChange[] {
  const added = after.languages.filter((language) => !before.languages.includes(language))
    .map((language): FormChange => ({ key: `language:${language}`, area: 'language', kind: 'added', id: language, fields: [], addresses: [] }))
  const removed = before.languages.filter((language) => language !== before.language && !after.languages.includes(language))
    .map((language): FormChange => ({ key: `language:${language}`, area: 'language', kind: 'removed', id: language, fields: [], addresses: [] }))
  return [...added, ...removed]
}

function welcomeChange(before: Welcome, after: Welcome, languages: readonly FormLanguage[]): FormChange[] {
  const fields = changedKeys(before, after, languages)
  return fields.length === 0 ? [] : [{ key: 'welcome', area: 'welcome', kind: 'changed', id: 'welcome', fields, addresses: [] }]
}

const noAddresses = (_field: HiddenField): SuggestedAddress[] => []

function ignoredAreas(before: FormV2, after: FormV2): IgnoredArea[] {
  const checks: Record<IgnoredArea, boolean> = {
    name: after.name !== '' && after.name !== before.name,
    theme: !same(before.theme, after.theme),
    routing: before.category !== after.category || before.subcategory !== after.subcategory,
    project: before.project_id !== after.project_id || before.document_id !== after.document_id,
    test: !same(before.settings, after.settings),
    tags: !same(before.tags, after.tags),
    dimensions: !same(before.dimension_defaults, after.dimension_defaults),
  }
  return IGNORED_AREAS.filter((area) => checks[area])
}

/** The AI's changes from `before` (the form as it is now) to `after` (its proposal). */
export function formDiff(before: FormV2, after: FormV2): FormDiff {
  // (a text in a language the AI added is that language's change; the primary can't change here)
  const languages = before.languages.filter((language) => after.languages.includes(language))
  return {
    changes: [
      ...keyedChanges('question', before.questions, after.questions, languages, questionAddresses),
      ...keyedChanges('ending', before.endings, after.endings, languages, endingAddresses),
      ...keyedChanges('hidden', before.hidden_fields, after.hidden_fields, languages, noAddresses),
      ...languageChanges(before, after),
      ...welcomeChange(before.welcome, after.welcome, languages),
    ],
    ignored: ignoredAreas(before, after),
  }
}

/** The changes that take effect: accepted, and with every address they bring in checked. */
export function effectiveChanges(diff: FormDiff, accepted: ReadonlySet<string>, checked: ReadonlySet<string>): Set<string> {
  return new Set(diff.changes
    .filter((change) => accepted.has(change.key) && change.addresses.every((address) => checked.has(address.url)))
    .map((change) => change.key))
}
