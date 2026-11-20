/**
 * @fileoverview Recall in a form's texts (7.61.00, docs/feedback-forms.md "Recall"): `{{id}}` or `{{id|fallback}}`
 * shows a hidden field's value, or an earlier question's answer, where it stands.
 *
 * ONE grammar, three implementations pinned by `schemas/form-recall-cases.json`: lambda/shared/forms_recall.py (the
 * server's 400s and the publish guard's 409), this module (the builder's problems, its "Insert a value" menu and its
 * preview) and lambda/api/static/feedback-widget.js (what respondents see, rendered by `renderRecall`'s rules).
 *
 * Recall works in the welcome's title and description, every question's headline and subheader, and every ending's
 * title and description. An id names a declared hidden field (looked up first) or a question placed BEFORE the text
 * whose answer is a score (rating, NPS, CSAT, CES) or a single choice (its label); never an open text, a contact, a
 * multiple choice, a consent or a matrix. Anywhere else (an option label, a button, a placeholder, an address) a
 * placeholder is shown as written, so it can never be published.
 *
 * @module pages/FeedbackForms/model/recall
 */
import type { FormV2, HiddenField, I18nText, Question } from './formsV2'
import { isChoice, isMatrix, isScale } from './formsV2'

/** One `{{…}}`: as written, its id and its fallback (both trimmed; '' for none). */
export interface Placeholder {
  readonly raw: string
  readonly id: string
  readonly fallback: string
}

/** Why a placeholder cannot be filled where it is (the server's 400 codes), or `recall_not_here`: a text where recall
 * never works. */
export type RecallCode = 'recall_unknown' | 'recall_not_before' | 'recall_type' | 'recall_not_here'

/** The question types whose answer can be recalled. */
const RECALL_TYPES: ReadonlySet<Question['type']> = new Set(['rating', 'nps', 'csat', 'ces', 'single_select'])

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g

/** The placeholders in `text`, in order. */
export function placeholders(text: string): Placeholder[] {
  if (!text.includes('{{')) return []
  return [...text.matchAll(PLACEHOLDER)].map((match) => {
    const inner = match[1] ?? ''
    const bar = inner.indexOf('|')
    return {
      raw: match[0],
      id: (bar < 0 ? inner : inner.slice(0, bar)).trim(),
      fallback: bar < 0 ? '' : inner.slice(bar + 1).trim(),
    }
  })
}

/** What stands for a placeholder that left nothing, while the text is tidied: a noncharacter, taken out of the text
 * and of every value first. */
const GAP = '\uffff'
const SPACE = '[ \\u00a0]*'
const SEPARATORS = '[,;:、，]'
const TERMINALS = '[.!?…。！？]'
const gapRule = (pattern: string, flags = 'g'): RegExp => new RegExp(pattern.replaceAll('G', '\\uffff'), flags)
const RULES: readonly (readonly [RegExp, string])[] = [
  [gapRule(`\\n${SPACE}G${SPACE}`), '\n'],
  [gapRule(`${SEPARATORS}?${SPACE}G${SPACE}(?=${TERMINALS})`), ''],
  [gapRule(`${SPACE}G${SPACE}(?=${SEPARATORS}|[)\\]])`), ''],
  [gapRule(`${SEPARATORS}?${SPACE}G${SPACE}(?=\\n|$)`), ''],
  [gapRule('[ \\u00a0]+G[ \\u00a0]*|[ \\u00a0]*G[ \\u00a0]+'), ' '],
  [gapRule('G'), ''],
]
const RUNS = gapRule(`G(?:${SPACE}G)+`)
const EMPTY_BRACKETS = gapRule(`[([]${SPACE}G${SPACE}[)\\]]`)
const AT_START = gapRule(`^${SPACE}G${SPACE}(${SEPARATORS}${SPACE})?`, '')

/** `text` tidied where a placeholder left nothing (`GAP`): the rules of `schemas/form-recall-cases.json`. */
function tidy(gapped: string): string {
  const joined = gapped.replace(RUNS, GAP).replace(EMPTY_BRACKETS, GAP)
  const start = AT_START.exec(joined)
  const rest = start === null ? joined : joined.slice(start[0].length)
  // (a separator taken off the start begins a new sentence: "{{name}}, how was it?" reads "How was it?")
  const text = start?.[1] === undefined ? rest : rest.charAt(0).toUpperCase() + rest.slice(1)
  return RULES.reduce((current, [rule, by]) => current.replace(rule, by), text)
}

const own = (values: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined

const withoutGap = (text: string): string => text.replaceAll(GAP, '')

/**
 * `text` as respondents see it with `values` (by id; an id without one shows its fallback, or nothing, and the text
 * is tidied around the gap). Values are never tidied, and are text, never markup.
 */
export function renderRecall(text: string, values: Readonly<Record<string, string>>): string {
  if (!text.includes('{{')) return text
  // (the text and the values hold no GAP of their own: one left in `filled` is a placeholder that showed nothing)
  const filled = withoutGap(text).replace(PLACEHOLDER, (_raw, inner: string) => {
    const bar = inner.indexOf('|')
    const id = (bar < 0 ? inner : inner.slice(0, bar)).trim()
    return withoutGap(own(values, id) ?? '').trim() || (bar < 0 ? '' : inner.slice(bar + 1).trim()) || GAP
  })
  return filled.includes(GAP) ? tidy(filled) : filled
}

/** `text` with each placeholder shown as `[id]`: how the server shows it to a reader of results (a CSV header, a
 * question's headline in Results), never a respondent's value. */
export const shownAsIds = (text: string): string =>
  text.replace(PLACEHOLDER, (_raw, inner: string) => `[${(inner.split('|')[0] ?? '').trim()}]`)

/** Where a text is, in the builder's terms (validateForm.ts `ProblemLocation`). */
export interface TextLocation {
  readonly kind: 'welcome' | 'question' | 'ending'
  readonly id?: string
  readonly field: string
  readonly optionIndex?: number
}

/** A text as a question holds it: an I18nText, an address, or nothing. */
type ShownText = I18nText | string | undefined

/** A text respondents may be shown: where it is, and how many questions come before it (recall texts only). */
export interface FormText {
  readonly at: TextLocation
  readonly text: ShownText
  /** The questions placed before the text, for a recall text; absent where recall never works. */
  readonly before?: number
}

/** The recall texts: the welcome's, each question's headline and subheader, each ending's title and description. */
export function recallTexts(form: FormV2): FormText[] {
  return [
    ...(['title', 'description'] as const).map((field) => ({ at: { kind: 'welcome' as const, field }, text: form.welcome[field], before: 0 })),
    ...form.questions.flatMap((q, index) => (['headline', 'subheader'] as const).map((field) =>
      ({ at: { kind: 'question' as const, id: q.id, field }, text: q[field], before: index }))),
    ...form.endings.flatMap((e) => (['title', 'description'] as const).map((field) =>
      ({ at: { kind: 'ending' as const, id: e.id, field }, text: e[field], before: form.questions.length }))),
  ]
}

const questionText = (q: Question, field: string, text: ShownText, optionIndex?: number): FormText =>
  ({ at: { kind: 'question', id: q.id, field, optionIndex }, text })

/** A choice's or a matrix's own lists and labels (none for any other type). */
function listTexts(q: Question): FormText[] {
  if (isChoice(q)) {
    return [...q.options.map((option, index) => questionText(q, 'option', option.label, index)),
      questionText(q, 'other_label', q.other.label), questionText(q, 'other_placeholder', q.other.placeholder),
      questionText(q, 'none_label', q.none.label)]
  }
  if (isMatrix(q)) {
    return [...q.rows.map((row, index) => questionText(q, 'row', row.label, index)),
      ...q.columns.map((column, index) => questionText(q, 'column', column.label, index))]
  }
  return []
}

/** A question's own texts where recall never works: its button, labels, placeholders, options, rows and columns. */
function questionOtherTexts(q: Question): FormText[] {
  const own: FormText[] = [questionText(q, 'button_label', q.button_label), ...listTexts(q)]
  if (isScale(q)) own.push(questionText(q, 'lower_label', q.lower_label), questionText(q, 'upper_label', q.upper_label))
  if (q.type === 'open_text') own.push(questionText(q, 'placeholder', q.placeholder))
  if (q.type === 'statement') own.push(questionText(q, 'cta_label', q.cta?.label), questionText(q, 'cta_url', q.cta?.url))
  if (q.type === 'consent') own.push(questionText(q, 'label', q.label))
  return own
}

/** Every text respondents may be shown where recall never works. */
export function otherTexts(form: FormV2): FormText[] {
  return [
    { at: { kind: 'welcome', field: 'button_label' }, text: form.welcome.button_label },
    ...form.questions.flatMap(questionOtherTexts),
    ...form.endings.flatMap((e) => (e.button === undefined ? [] : [
      { at: { kind: 'ending' as const, id: e.id, field: 'button_label' }, text: e.button.label },
      { at: { kind: 'ending' as const, id: e.id, field: 'button_url' }, text: e.button.url },
    ])),
  ]
}

const hiddenIds = (form: FormV2): Set<string> => new Set(form.hidden_fields.map((field) => field.id))

/** Why `id` cannot be recalled in a text `before` questions in (null: it can). */
export function recallProblem(form: FormV2, before: number, id: string): Exclude<RecallCode, 'recall_not_here'> | null {
  if (hiddenIds(form).has(id)) return null
  const position = form.questions.findIndex((q) => q.id === id)
  const question = form.questions[position]
  if (question === undefined) return 'recall_unknown'
  if (position >= before) return 'recall_not_before'
  return RECALL_TYPES.has(question.type) ? null : 'recall_type'
}

/** One placeholder respondents would see as written: where, in which language, and why. */
export interface UnresolvedPlaceholder {
  readonly at: TextLocation
  readonly language?: string
  readonly placeholder: string
  readonly code: RecallCode
}

const entries = (text: ShownText): [string | undefined, string][] => {
  if (text === undefined) return []
  if (typeof text === 'string') return [[undefined, text]]
  return Object.entries(text)
}

/** Every placeholder respondents would see as written (the server's 409 `unresolved_placeholder`, before publish). */
export function unresolvedPlaceholders(form: FormV2): UnresolvedPlaceholder[] {
  const recall = recallTexts(form).flatMap(({ at, text, before }) => entries(text).flatMap(([language, value]) =>
    placeholders(value).flatMap((found) => {
      const code = recallProblem(form, before ?? 0, found.id)
      return code === null ? [] : [{ at, language, placeholder: found.raw, code }]
    })))
  const other = otherTexts(form).flatMap(({ at, text }) => entries(text).flatMap(([language, value]) =>
    placeholders(value).map((found) => ({ at, language, placeholder: found.raw, code: 'recall_not_here' as const }))))
  return [...recall, ...other]
}

/** What a text `before` questions in may recall (the "Insert a value" menu): the hidden fields, then the earlier
 * questions whose answer can be recalled. */
export function recallChoices(form: FormV2, before: number): { readonly hidden: readonly HiddenField[]; readonly questions: readonly Question[] } {
  return {
    hidden: form.hidden_fields,
    questions: form.questions.slice(0, Math.max(before, 0)).filter((q) => RECALL_TYPES.has(q.type)),
  }
}

/** The hidden fields the form's recall texts recall, in the form's order (the Share tab warns when a link leaves one
 * of them empty). */
export function recalledHiddenIds(form: FormV2): string[] {
  const named = new Set(recallTexts(form).flatMap(({ text }) => entries(text).flatMap(([, value]) => placeholders(value).map((found) => found.id))))
  return form.hidden_fields.map((field) => field.id).filter((id) => named.has(id))
}
