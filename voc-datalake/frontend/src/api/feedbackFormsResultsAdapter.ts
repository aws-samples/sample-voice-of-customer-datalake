/**
 * @fileoverview Part A's Results and Responses answers (shared/forms_v2_results.py `tally_results`, the responses
 * route's `_response_view`) read as the shapes this app parses (feedbackFormsV2Results.ts). A body already in this
 * app's shape (the dev mock) passes through unchanged.
 *
 * Results: `{responses, test_responses, last_response_at, questions: [{id, type, shown, answered, skipped, not_shown,
 * earlier_version?, options?: {<code>: n}, other?, other_latest?: [{value, response_id, created_at, is_test,
 * sentiment?}], none?, removed_options?: {<code>: n}, histogram?: {<score>: n}, average?, count?, latest?: […],
 * accepted?, contacts?, rows?: [{code, answered, counts, average}], scored?, removed_rows?, removed_columns?}],
 * endings, removed_questions: [{id, answered}], funnel: {opened, left: {<qid>: n}, completed} | null, link_health}`
 * (`earlier_version`: answers to a revision where the question had another type or range, counted nowhere else;
 * `funnel` null under a language, ending or hidden-value filter; a matrix's rows, kept as `matrix`;
 * `link_health`, as it is).
 *
 * Responses: rows `{response_id, is_test, created_at, revision, language, ending_id, answers, hidden, path,
 * sentiment?, feedback_id?}`.
 *
 * @module api/feedbackFormsResultsAdapter
 */
import { z } from 'zod'
import { isRecord } from '../lib/typeGuards'

const numberIn = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const latestEntry = z.object({
  value: z.string(),
  response_id: z.string().catch(''),
  created_at: z.string().catch(''),
  is_test: z.boolean().catch(false),
  sentiment: z.string().optional().catch(undefined),
})
const latestList = z.array(z.unknown()).catch([]).transform((items) => items.flatMap((item) => {
  const parsed = latestEntry.safeParse(item)
  return parsed.success ? [parsed.data] : []
}))

/** An open-text or Other answer as this app lists it (a test response has no feedback item). */
const asLatest = (entry: z.infer<typeof latestEntry>) => ({
  text: entry.value, sentiment: entry.sentiment, submitted_at: entry.created_at, is_test: entry.is_test,
  feedback_id: entry.is_test || entry.response_id === '' ? undefined : entry.response_id,
})

/** Option counts with Other and None folded in under their codes. */
function countsOf(question: Record<string, unknown>): Record<string, number> | undefined {
  const options = question['options']
  if (!isRecord(options)) return undefined
  const counts: Record<string, number> = Object.fromEntries(Object.entries(options).map(([code, n]) => [code, numberIn(n)]))
  if (question['other'] !== undefined) counts['other'] = numberIn(question['other'])
  if (question['none'] !== undefined) counts['none'] = numberIn(question['none'])
  return counts
}

/** A matrix's figures (its rows' distributions and averages, what it no longer has), or undefined for another type. */
function matrixOf(question: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(question['rows'])) return undefined
  return { rows: question['rows'], scored: question['scored'], removed_rows: question['removed_rows'] ?? {}, removed_columns: question['removed_columns'] ?? {} }
}

function aggregateOf(question: Record<string, unknown>): Record<string, unknown> {
  const latest = latestList.parse(question['latest'])
  const contacts = question['contacts']
  return {
    answered: question['answered'], skipped: question['skipped'], not_shown: question['not_shown'],
    earlier_version: question['earlier_version'],
    counts: countsOf(question),
    other_answers: question['other_latest'] === undefined ? undefined : latestList.parse(question['other_latest']).map((entry) => entry.value),
    distribution: question['histogram'],
    average: question['average'],
    accepted: question['accepted'],
    // (part A counts the people who left contact details, not their kinds)
    contact: contacts === undefined ? undefined : { left: contacts },
    latest: question['latest'] === undefined ? undefined : latest.map(asLatest),
    matrix: matrixOf(question),
  }
}

/**
 * Part A's funnel (opened, where those who left stopped) as steps: reached = completed + those who left at it or later.
 * The route always answers one; with no open counted, or fewer opens than responses (answered before the beacon, or
 * through a version 1 widget), the counts don't cover the view, so there is none (the page shows Reach instead).
 */
function funnelOf(funnel: unknown, order: readonly string[]): unknown {
  if (!isRecord(funnel) || !isRecord(funnel['left'])) return funnel ?? null
  const left = funnel['left']
  const completed = numberIn(funnel['completed'])
  if (numberIn(funnel['opened']) === 0 || numberIn(funnel['opened']) < completed) return null
  const steps = order.map((id, index) => ({
    question_id: id,
    reached: completed + order.slice(index).reduce((sum, later) => sum + numberIn(left[later]), 0),
  }))
  return { opened: numberIn(funnel['opened']), started: steps[0]?.reached ?? completed, steps, completed }
}

/** A Results answer in this app's shape. */
export function adaptResults(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw['questions'])) return raw
  const questions = raw['questions'].filter(isRecord).filter((question) => typeof question['id'] === 'string')
  const ids = questions.map((question) => String(question['id']))
  const removedOptions = Object.fromEntries(questions.flatMap((question) => {
    const removed = question['removed_options']
    return isRecord(removed)
      ? [[String(question['id']), Object.entries(removed).map(([code, n]) => ({ code, label: {}, count: numberIn(n) }))]]
      : []
  }))
  return {
    total: raw['responses'],
    test_count: raw['test_responses'],
    last_response_at: raw['last_response_at'],
    questions: Object.fromEntries(questions.map((question) => [String(question['id']), aggregateOf(question)])),
    endings: raw['endings'],
    removed_questions: raw['removed_questions'],
    removed_options: removedOptions,
    funnel: funnelOf(raw['funnel'], ids),
    link_health: raw['link_health'],
  }
}

/** A Responses page in this app's shape (`created_at` → `submitted_at`, `revision` → `form_revision`). */
export function adaptResponsesPage(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw['responses'])) return raw
  const rows: readonly unknown[] = raw['responses']
  return {
    ...raw,
    responses: rows.map((row) => (isRecord(row) && row['submitted_at'] === undefined
      ? { ...row, submitted_at: row['created_at'], form_revision: row['form_revision'] ?? row['revision'] }
      : row)),
  }
}
