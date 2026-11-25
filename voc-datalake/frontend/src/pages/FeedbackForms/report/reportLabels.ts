/**
 * @fileoverview What the Report (7.63.00) names, in the form's own words: the segments a view may group by (each hidden
 * field, each single choice, each row of a matrix: the server's `group_by`), a segment's value (an option's or a
 * column's label, never a code where the form has a label), one figure of a question (its NPS, CSAT %, CES % or
 * average out of its points), and the view an AI summary was made for.
 *
 * @module pages/FeedbackForms/report/reportLabels
 */
import type { FormReport, ReportAi, ReportKpi, ScoreFigure } from '../../../api/feedbackFormsReport'
import { isSummaryOfView } from '../../../api/feedbackFormsV2Api'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import { isSupportedLanguage, languageNames } from '../../../i18n/languages'
import { formatDate } from '../../../utils/dateUtils'
import { formatDecimal, formatPercent } from '../../../utils/numberFormat'
import type { FormV2 } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { headlineShown } from '../model/recall'
import { endingTitle } from '../results/answers'

export interface SegmentChoice {
  /** As the server's `group_by` names it. */
  readonly value: string
  readonly label: string
}

/** Every segment the form's responses can be grouped by, in the form's order: hidden fields, then its questions. */
export function segmentChoices(form: FormV2): SegmentChoice[] {
  const hidden = form.hidden_fields.map((field) => ({ value: `hidden.${field.id}`, label: field.label === undefined || field.label === '' ? field.id : field.label }))
  const questions = form.questions.flatMap((question): SegmentChoice[] => {
    const headline = headlineShown(question.headline, form.language) || question.id
    if (question.type === 'single_select') return [{ value: question.id, label: headline }]
    if (question.type === 'matrix') {
      return question.rows.map((row) => ({ value: `${question.id}.${row.code}`, label: `${headline}: ${textIn(row.label, form.language) || row.code}` }))
    }
    return []
  })
  return [...hidden, ...questions]
}

/** The label of the option, Other row or matrix column `code` of the question a `group_by` names, if it has one. */
function segmentCodeLabel(form: FormV2, groupBy: string, code: string, other: string): string | undefined {
  const [questionId, row] = groupBy.split('.')
  const question = form.questions.find((candidate) => candidate.id === questionId)
  if (question?.type === 'single_select') {
    return code === 'other' ? textIn(question.other.label, form.language) || other
      : textIn(question.options.find((option) => option.code === code)?.label, form.language)
  }
  return question?.type === 'matrix' && row !== undefined
    ? textIn(question.columns.find((column) => column.code === code)?.label, form.language) : undefined
}

/** A segment's value as the form words it (`''`: the responses without one, worded by `none`). */
export function segmentValueLabel(form: FormV2, groupBy: string, value: string, none: string, other: string): string {
  if (value === '') return none
  const label = segmentCodeLabel(form, groupBy, value, other) ?? ''
  return label === '' ? value : label
}

/** One figure of a question in the reader's language: "NPS 42", "CSAT 80%", "CES 75%", "4.2 / 5"; "—" without one. */
export function figureText(figure: ScoreFigure | undefined, language: string): string {
  if (figure === undefined) return '—'
  if (figure.nps !== undefined && figure.nps !== null) return formatDecimal(figure.nps, language, 0)
  if (figure.csat !== undefined && figure.csat !== null) return formatPercent(figure.csat, language)
  if (figure.ces !== undefined && figure.ces !== null) return formatPercent(figure.ces, language)
  if (figure.average === undefined || figure.average === null) return '—'
  return figure.scale_max === undefined ? formatDecimal(figure.average, language, 1) : `${formatDecimal(figure.average, language, 1)} / ${figure.scale_max}`
}

/** A matrix's figure in a segment: each row's average, "Labs 3.2 · Demo 2.8" (rows none scored left out). */
export function rowAveragesText(form: FormV2, questionId: string, figure: ScoreFigure | undefined, language: string): string {
  const question = form.questions.find((candidate) => candidate.id === questionId)
  if (question?.type !== 'matrix' || figure?.rows === undefined) return '—'
  const rows = figure.rows
  const parts = question.rows.flatMap((row) => {
    const average = rows[row.code]
    return average === undefined || average === null ? [] : [`${textIn(row.label, form.language) || row.code} ${formatDecimal(average, language, 1)}`]
  })
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/** The measured questions (rating, NPS, CSAT, CES, matrix) a segment table or a comparison has a column for. */
export function measuredIds(form: FormV2): string[] {
  return form.questions.filter((question) => ['rating', 'nps', 'csat', 'ces', 'matrix'].includes(question.type)).map((question) => question.id)
}

/** The question's headline as Results show it (a recalled value as `[id]`), its id without one. */
export function questionHeadline(form: FormV2, questionId: string): string {
  const question = form.questions.find((candidate) => candidate.id === questionId)
  return question === undefined ? questionId : headlineShown(question.headline, form.language) || questionId
}

/** A heatmap cell's shade for a share in percent, in four steps (none, some, a quarter or more, half or more): the
 * Report's and its PDF's. */
export function shadeStep(percent: number): 0 | 1 | 2 | 3 {
  if (percent >= 50) return 3
  if (percent >= 25) return 2
  return percent > 0 ? 1 : 0
}

/** A KPI's headline value in the reader's language: NPS (−100 to 100), CSAT % satisfied, CES % easy, or the average
 * out of the scale's points; "—" with no answer. */
export function kpiValue(kpi: ReportKpi, language: string): string {
  if (kpi.answered === 0) return '—'
  if (kpi.nps !== undefined) return formatDecimal(kpi.nps.score, language, 0)
  if (kpi.csat !== undefined) return formatPercent(kpi.csat.score, language)
  if (kpi.ces !== undefined) return formatPercent(kpi.ces.score, language)
  if (kpi.average === null) return '—'
  return kpi.scale_max === undefined ? formatDecimal(kpi.average, language, 1) : `${formatDecimal(kpi.average, language, 1)} / ${kpi.scale_max}`
}

/** A matrix's row and column labels in the form's language (each code itself where the form has no label). */
export function matrixLabels(form: FormV2, questionId: string): { readonly row: (code: string) => string; readonly column: (code: string) => string } {
  const question = form.questions.find((candidate) => candidate.id === questionId)
  const matrix = question?.type === 'matrix' ? question : null
  return {
    row: (code) => textIn(matrix?.rows.find((entry) => entry.code === code)?.label, form.language) || code,
    column: (code) => textIn(matrix?.columns.find((entry) => entry.code === code)?.label, form.language) || code,
  }
}

type Translate = (key: string, options?: Record<string, unknown>) => string

const RANGE_KEYS: Readonly<Record<string, string>> = {
  all: 'results.filters.all', '7': 'results.filters.days7', '30': 'results.filters.days30', '90': 'results.filters.days90',
}

/** The view an AI summary was made for, in the form's words: "Last 30 days · Polski · customer: Example Ltd" (its
 * stored filters, as feedbackFormsV2Api.ts `summaryFilters` records them). */
export function summaryViewText(form: FormV2, filters: Readonly<Record<string, string>>, t: Translate, language: string): string {
  const days = filters['days']
  const from = filters['from']
  const range = days === undefined ? undefined : RANGE_KEYS[days]
  const parts: string[] = []
  if (range !== undefined) parts.push(t(range))
  else if (from !== undefined) parts.push(t('feedbackForms:report.ai.since', { date: formatDate(from, language) }))
  const chosen = filters['language']
  if (chosen !== undefined) parts.push(isSupportedLanguage(chosen) ? languageNames[chosen] : chosen)
  const ending = filters['ending']
  if (ending !== undefined) parts.push(endingTitle(form, ending))
  for (const [key, value] of Object.entries(filters)) {
    if (!key.startsWith('hidden.')) continue
    const id = key.slice('hidden.'.length)
    const field = form.hidden_fields.find((candidate) => candidate.id === id)
    parts.push(`${field?.label === undefined || field.label === '' ? id : field.label}: ${value}`)
  }
  return parts.join(' · ')
}

/** The report's stored AI summary for this view, or null: none, or one made for another view (shown and printed only on
 * its own; a summary withheld from this reader is its own case). */
export function summaryOfView(report: FormReport, filters: ResultsFilters): ReportAi | null {
  const ai = report.ai
  if (ai === null) return null
  return ai.withheld !== undefined || isSummaryOfView(ai.filters, filters) ? ai : null
}
