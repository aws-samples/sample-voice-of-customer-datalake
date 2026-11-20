/**
 * @fileoverview A form's Report (7.63.00, docs/feedback-forms.md "Report" and "Compare") as this app reads it,
 * leniently: a malformed part costs only itself.
 *
 * - `GET /feedback-forms/{id}/report?…[&group_by=]` (the Results filters) → `{name, template, responses,
 *   first_response_at, last_response_at, kpis, matrices, segments, themes, ai, min_segment}`: the KPIs of each rating,
 *   NPS, CSAT and CES question, each matrix as a heatmap, the segments (each of at least 5 responses; the smaller ones
 *   merged into "Other (fewer than 5)", whose figures stay withheld under 5), the deterministic themes per open-text
 *   question with real quotes, and the newest AI summary as this reader may see it (or `withheld: 'access'`).
 * - `GET /feedback-forms/{id}/compare?with=<ids>&by=hidden.<id>` → `{by, min_size, questions, forms, points}`.
 * - `POST /settings/form-reports` `{form_id, answers: [{response_id, text}], filters, responses, last_response_at}` →
 *   202 `{job_id}`, polled at `GET /settings/form-reports/{job_id}` until `{success, form_id, report_id}` (or a refusal:
 *   `no_summary`, `no_model`, `form_deleted`); the report then carries it.
 *
 * @module api/feedbackFormsReport
 */
import { z } from 'zod'
import { parsedList as listOf } from './schemaList'
import { count, countMap } from './feedbackFormsV2Results'
import type { FormResponse } from './feedbackFormsV2Results'
import type { FormV2 } from '../pages/FeedbackForms/model/formsV2'

const score = z.number().nullable().optional().catch(undefined)
/** One question's compact figure for a segment or a comparison's point. */
const figure = z.object({
  type: z.string().catch(''),
  answered: count,
  average: score,
  scale_max: z.number().int().positive().optional().catch(undefined),
  nps: score,
  csat: score,
  ces: score,
  rows: z.record(z.string(), z.number().nullable()).optional().catch(undefined),
})
export type ScoreFigure = z.infer<typeof figure>
/** Figures by question id; null when withheld (fewer than the minimum responses). */
const scores = z.record(z.string(), z.unknown()).nullable().catch(null).transform((raw) => (raw === null ? null
  : Object.fromEntries(Object.entries(raw).flatMap(([id, value]) => {
    const parsed = figure.safeParse(value)
    return parsed.success ? [[id, parsed.data] as const] : []
  }))))
export type Scores = z.infer<typeof scores>

const segments = z.object({
  by: z.string().catch(''),
  min_size: count,
  groups: listOf(z.object({ value: z.string(), responses: count, scores })),
  merged: z.object({ segments: count, responses: count, scores }).nullable().catch(null),
})
export type ReportSegments = z.infer<typeof segments>

const kpi = z.object({
  id: z.string().min(1),
  type: z.string().catch(''),
  answered: count,
  skipped: count,
  average: z.number().nullable().catch(null),
  scale_max: z.number().int().positive().optional().catch(undefined),
  nps: z.object({ score: z.number(), promoters: count, passives: count, detractors: count }).optional().catch(undefined),
  csat: z.object({ score: z.number(), satisfied: count }).optional().catch(undefined),
  ces: z.object({ score: z.number(), easy: count }).optional().catch(undefined),
})
export type ReportKpi = z.infer<typeof kpi>

const heatmap = z.object({
  id: z.string().min(1),
  answered: count,
  scored: z.boolean().catch(false),
  columns: z.array(z.string()).catch([]),
  rows: listOf(z.object({ code: z.string().min(1), answered: count, counts: countMap, average: z.number().nullable().catch(null) })),
})
export type ReportHeatmap = z.infer<typeof heatmap>

const quote = z.object({
  response_id: z.string().min(1),
  text: z.string().min(1),
  created_at: z.string().catch(''),
  sentiment: z.string().catch('unknown'),
})

const theme = z.object({
  category: z.string().catch(''),
  subcategory: z.string().catch(''),
  count,
  sentiment: countMap,
  quotes: listOf(quote),
})
export type ReportTheme = z.infer<typeof theme>
const questionThemes = z.object({ question_id: z.string().min(1), answered: count, themes: listOf(theme) })
export type QuestionThemes = z.infer<typeof questionThemes>

const aiTheme = z.object({
  label: z.string().min(1),
  count,
  sentiment: z.string().catch('mixed'),
  quotes: listOf(z.object({ response_id: z.string().min(1), text: z.string().min(1) })),
})
const ai = z.object({
  report_id: z.string().min(1),
  created_at: z.string().catch(''),
  withheld: z.literal('access').optional().catch(undefined),
  summary: z.string().catch(''),
  model: z.string().nullable().optional().catch(null),
  stale: z.boolean().catch(false),
  responses_counted: z.number().int().nonnegative().nullable().optional().catch(null),
  themes: listOf(aiTheme),
})
export type ReportAi = z.infer<typeof ai>

const report = z.object({
  name: z.string().catch(''),
  responses: count,
  test_responses: count,
  first_response_at: z.string().nullable().catch(null),
  last_response_at: z.string().nullable().catch(null),
  kpis: listOf(kpi),
  matrices: listOf(heatmap),
  segments: segments.nullable().optional().catch(null).transform((value) => value ?? null),
  themes: listOf(questionThemes),
  ai: ai.nullable().optional().catch(null).transform((value) => value ?? null),
  min_segment: z.number().int().positive().catch(5),
})
export type FormReport = z.infer<typeof report>

export function parseFormReport(raw: unknown): FormReport {
  return report.parse(typeof raw === 'object' && raw !== null ? raw : {})
}

const comparison = z.object({
  by: z.string().nullable().catch(null),
  min_size: z.number().int().positive().catch(5),
  questions: listOf(z.object({ id: z.string().min(1), type: z.string().catch(''), headline: z.string().catch('') })),
  forms: listOf(z.object({
    form_id: z.string().min(1),
    name: z.string().catch(''),
    same_template: z.boolean().catch(false),
    matched: z.array(z.string()).catch([]),
    unmatched: z.record(z.string(), z.enum(['missing', 'different'])).catch({}),
  })),
  points: listOf(z.object({
    form_id: z.string().min(1),
    value: z.string().nullable().catch(null),
    responses: count,
    first_response_at: z.string().nullable().catch(null),
    last_response_at: z.string().nullable().catch(null),
    scores,
    merged: z.boolean().optional().catch(undefined),
  })),
})
export type FormComparison = z.infer<typeof comparison>

export function parseFormComparison(raw: unknown): FormComparison {
  return comparison.parse(typeof raw === 'object' && raw !== null ? raw : {})
}

/** One answer the AI summary reads: a response's free-text answers, joined. */
export interface SummaryAnswer {
  readonly response_id: string
  readonly text: string
}

/** The most answers, and characters, one summary sends (the route's limits). */
export const SUMMARY_LIMITS = { answers: 300, chars: 60_000, answerChars: 10_000 } as const

/**
 * What a summary reads of `responses` (newest first): each one's free-text answers (an open text that asks for an
 * email or a phone number is a contact detail, never sent), joined in the form's order, within the route's limits.
 */
export function summaryAnswers(form: FormV2, responses: readonly FormResponse[]): SummaryAnswer[] {
  const questions = form.questions.filter((question) => question.type === 'open_text' && (question.long || question.input_type === 'text'))
  const answers = responses.flatMap((response) => {
    const texts = questions.map((question) => response.answers[question.id]).filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    const text = texts.join('\n').slice(0, SUMMARY_LIMITS.answerChars).trim()
    return text === '' ? [] : [{ response_id: response.response_id, text }]
  })
  // (the newest first, up to the route's count and characters)
  const totals = answers.map((_answer, index) => answers.slice(0, index + 1).reduce((sum, answer) => sum + answer.text.length, 0))
  return answers.filter((_answer, index) => index < SUMMARY_LIMITS.answers && (totals[index] ?? 0) <= SUMMARY_LIMITS.chars)
}
