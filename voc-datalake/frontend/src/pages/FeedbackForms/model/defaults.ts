/**
 * @fileoverview New questions, endings and forms as the builder adds them (UX §3.3, §7): a new question's headline is
 * empty (the editor shows "New question" as its placeholder, so it is a problem until written); a choice starts with
 * two empty options, a matrix with two empty rows and four empty columns (the builder fills in a scale in the form's
 * language, questions/matrixOps.ts); an ending starts with the given title.
 *
 * `convertQuestion` is UX §4.7's type change: only the conversions that keep the content, and what each one loses.
 *
 * @module pages/FeedbackForms/model/defaults
 */
import type {
  ChoiceQuestion, Ending, FormLanguage, FormV2, Question, QuestionType, Rule, ScoreQuestion,
} from './formsV2'
import { DEFAULT_THEME, isChoice, isScale } from './formsV2'
import { scaleOf } from './rules'
import { textOf } from './i18nText'

const NO_FIELD = { show: false, required: false }

/** What a new form starts with besides its texts: a test link that is off (tagging), the default theme, and no
 * routing, link, custom fields or labels. */
export function newFormSettings(): Pick<FormV2, 'settings' | 'theme' | 'category' | 'subcategory' | 'project_id'
  | 'document_id' | 'custom_fields' | 'dimension_defaults' | 'tags'> {
  return {
    settings: { test: { link_enabled: false, record: 'tag' } },
    theme: { ...DEFAULT_THEME }, category: '', subcategory: '', project_id: '', document_id: '',
    custom_fields: [], dimension_defaults: {}, tags: [],
  }
}

/** A new question of `type` with `id`: required where respondents can't usefully skip it. */
export function newQuestion(type: QuestionType, id: string): Question {
  const base = { id, headline: {}, required: true }
  switch (type) {
    case 'single_select': case 'multi_select':
      return {
        ...base, type, options: [{ code: 'option', label: {} }, { code: 'option_2', label: {} }],
        other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
      }
    case 'open_text': return { ...base, type, required: false, long: true, input_type: 'text' }
    case 'rating': return { ...base, type, scale: 'star', range: 5 }
    case 'nps': case 'csat': case 'ces': return { ...base, type }
    case 'statement': return { ...base, type, required: false }
    case 'consent': return { ...base, type, required: false, label: {} }
    case 'contact_info':
      return { ...base, type, fields: { name: { show: true, required: false }, email: { show: true, required: true }, phone: NO_FIELD, company: NO_FIELD } }
    case 'matrix':
      return {
        ...base, type, required: false, shuffle_rows: false, display: 'auto',
        rows: [{ code: 'row', label: {} }, { code: 'row_2', label: {} }],
        columns: ['column', 'column_2', 'column_3', 'column_4'].map((code) => ({ code, label: {} })),
      }
  }
}

export function newEnding(id: string, language: FormLanguage, title: string): Ending {
  return { id, title: textOf(language, title) }
}

/** The types a question can become without losing its content (UX §4.7). */
export function convertibleTypes(question: Question): QuestionType[] {
  if (question.type === 'single_select') return ['multi_select']
  if (question.type === 'multi_select') return ['single_select']
  if (isScale(question)) return (['rating', 'nps', 'csat', 'ces'] as const).filter((type) => type !== question.type)
  return []
}

/** What a conversion drops, as the confirm lists it (`types.lost.<what>`). */
type LostPart = 'none' | 'minMax' | 'includesAll' | 'rulesOutsideScale'

export interface Converted {
  readonly question: Question
  readonly lost: readonly LostPart[]
}

function toSingle(q: ChoiceQuestion): Converted {
  const logic = q.logic ?? []
  const kept: Rule[] = logic.filter((rule) => rule.when.op !== 'includes_all')
  const lost: LostPart[] = [
    ...(q.none.enabled ? ['none' as const] : []),
    ...(q.min !== undefined || q.max !== undefined ? ['minMax' as const] : []),
    ...(kept.length < logic.length ? ['includesAll' as const] : []),
  ]
  return { lost, question: { ...q, type: 'single_select', none: { enabled: false }, min: undefined, max: undefined, logic: kept.length === 0 ? undefined : kept } }
}

function toMulti(q: ChoiceQuestion): Converted {
  const logic = q.logic?.map((rule): Rule => (rule.when.op === 'equals' && typeof rule.when.value === 'string'
    ? { ...rule, when: { op: 'includes_any', value: [rule.when.value] } } : rule))
    .filter((rule) => rule.when.op !== 'not_equals')
  return { lost: [], question: { ...q, type: 'multi_select', logic } }
}

function toScale(q: Question, type: 'rating' | 'nps' | 'csat' | 'ces'): Converted {
  const labels = isScale(q) ? { lower_label: q.lower_label, upper_label: q.upper_label } : {}
  const next: Question = type === 'rating'
    ? { id: q.id, headline: q.headline, subheader: q.subheader, required: q.required, button_label: q.button_label, type, scale: 'number', range: 10, ...labels }
    : { id: q.id, headline: q.headline, subheader: q.subheader, required: q.required, button_label: q.button_label, type, ...labels } satisfies ScoreQuestion
  const scale = scaleOf(next)
  const logic = (q.logic ?? []).filter((rule) => typeof rule.when.value !== 'number' || scale === null
    || (rule.when.value >= scale.min && rule.when.value <= scale.max))
  const lost: LostPart[] = logic.length < (q.logic ?? []).length ? ['rulesOutsideScale'] : []
  return { lost, question: { ...next, logic: logic.length === 0 ? undefined : logic } }
}

/** `question` as `type` (one of `convertibleTypes`), or null when that conversion would lose its content. */
export function convertQuestion(question: Question, type: QuestionType): Converted | null {
  if (!convertibleTypes(question).includes(type)) return null
  if (isChoice(question)) return type === 'single_select' ? toSingle(question) : toMulti(question)
  if (type === 'rating' || type === 'nps' || type === 'csat' || type === 'ces') return toScale(question, type)
  return null
}
