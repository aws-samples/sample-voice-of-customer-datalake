/**
 * @fileoverview The shapes of a form's Results (UX §10, §16) as this app reads them, leniently: a malformed question
 * aggregate or response row costs only itself.
 *
 * `GET /feedback-forms/{id}/results` →
 * ```
 * { total, test_count, last_response_at,
 *   questions: { <qid>: { answered, skipped, not_shown, earlier_version?, follow_up_of?, counts?: {<code>|other|none: n}, other_answers?: [text],
 *                         distribution?: {<score>: n}, average?, accepted?, contact?: {left, emails, phones},
 *                         latest?: [{text, sentiment?, feedback_id?, submitted_at?, is_test?}], changed_at? } },
 *   endings: { <eid>: n },
 *   removed_questions?: [{ id, type, headline, answered }],
 *   removed_options?: { <qid>: [{ code, label, count }] },
 *   funnel?: { opened, started, steps: [{ question_id, reached }], completed } | null,
 *   link_health: { responses, hidden: {<id>: {filled, missing}}, by_channel: {<channel>: {responses, hidden}},
 *                  warnings: [{ id, kind, filled, total }] } | null }
 * ```
 * A matrix question's aggregate adds `matrix: { rows: [{ code, answered, counts: {<column>: n}, average }], scored,
 * removed_rows: {<code>: n}, removed_columns: {<code>: n} }` (7.61.00). `link_health` (7.61.00) is null from a server
 * that answers none.
 * `GET /feedback-forms/{id}/responses` → `{ responses: [{ response_id, submitted_at, form_revision, language,
 * answers: {<qid>: value}, hidden: {<id>: value}, ending_id, is_test, feedback_id? }], next_cursor }`.
 *
 * @module api/feedbackFormsV2Results
 */
import { z } from 'zod'

export const count = z.number().int().nonnegative().catch(0)
export const countMap = z.record(z.string(), z.number().int().nonnegative()).catch({})
const optionalText = z.string().optional().catch(undefined)

const latestAnswer = z.object({
  text: z.string(),
  sentiment: z.string().nullable().optional().catch(undefined),
  feedback_id: optionalText,
  submitted_at: optionalText,
  is_test: z.boolean().optional().catch(undefined),
})
const listOf = <T extends z.ZodType>(item: T) => z.array(z.unknown()).catch([]).transform((items) => items.flatMap((raw) => {
  const parsed = item.safeParse(raw)
  return parsed.success ? [parsed.data] : []
}))

const matrixRow = z.object({ code: z.string().min(1), answered: count, counts: countMap, average: z.number().nullable().catch(null) })
const matrixAggregate = z.object({ rows: listOf(matrixRow), scored: z.boolean().catch(false), removed_rows: countMap, removed_columns: countMap })
export type MatrixAggregate = z.infer<typeof matrixAggregate>

const questionAggregate = z.object({
  answered: count,
  skipped: count,
  not_shown: count,
  /** Answers to a revision where the question had another type or range: never read on this one. */
  earlier_version: z.number().int().nonnegative().optional().catch(undefined),
  /** An "Ask why" follow-up (7.63.00): the score question it asks about. */
  follow_up_of: z.string().min(1).optional().catch(undefined),
  counts: countMap.optional(),
  other_answers: z.array(z.string()).optional().catch(undefined),
  distribution: countMap.optional(),
  average: z.number().nullable().optional().catch(undefined),
  accepted: z.number().int().nonnegative().optional().catch(undefined),
  // (emails and phones are null when the server counts only the people who left details, as part A does)
  contact: z.object({ left: count, emails: z.number().int().nonnegative().nullable().catch(null), phones: z.number().int().nonnegative().nullable().catch(null) })
    .optional().catch(undefined),
  latest: listOf(latestAnswer).optional(),
  changed_at: optionalText,
  matrix: matrixAggregate.optional().catch(undefined),
})
export type QuestionAggregate = z.infer<typeof questionAggregate>

const removedQuestion = z.object({
  id: z.string().min(1),
  type: z.string().catch(''),
  headline: z.record(z.string(), z.string()).catch({}),
  answered: count,
})
const removedOption = z.object({ code: z.string().min(1), label: z.record(z.string(), z.string()).catch({}), count })

const funnel = z.object({
  opened: count,
  started: count,
  steps: listOf(z.object({ question_id: z.string().min(1), reached: count })),
  completed: count,
})
export type FormFunnel = z.infer<typeof funnel>

/** Each entry of a record that parses, the others left out. */
const recordOf = <T extends z.ZodType>(item: T) => z.record(z.string(), z.unknown()).catch({}).transform((raw) =>
  Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    const parsed = item.safeParse(value)
    return parsed.success ? [[key, parsed.data] as const] : []
  })))
const hiddenFills = recordOf(z.object({ filled: count, missing: count }))
const linkWarning = z.object({ id: z.string().min(1), kind: z.enum(['never_filled', 'mostly_missing']), filled: count, total: count })
const linkHealth = z.object({
  responses: count,
  hidden: hiddenFills,
  by_channel: recordOf(z.object({ responses: count, hidden: hiddenFills })),
  warnings: listOf(linkWarning),
})
export type LinkHealth = z.infer<typeof linkHealth>
export type LinkWarning = z.infer<typeof linkWarning>

const results = z.object({
  total: count,
  test_count: count,
  last_response_at: z.string().nullable().catch(null),
  questions: recordOf(questionAggregate),
  endings: countMap,
  removed_questions: listOf(removedQuestion),
  removed_options: z.record(z.string(), z.unknown()).catch({}).transform((raw) => Object.fromEntries(Object.entries(raw)
    .map(([id, value]) => [id, listOf(removedOption).parse(value)] as const))),
  funnel: funnel.nullable().optional().catch(null).transform((value) => value ?? null),
  link_health: linkHealth.nullable().optional().catch(null).transform((value) => value ?? null),
})
export type FormResults = z.infer<typeof results>

export function parseFormResults(raw: unknown): FormResults {
  return results.parse(typeof raw === 'object' && raw !== null ? raw : {})
}

/** One answer as stored (contract "Response, v2"): a string, a number, a bool, or an object per type. */
const answerValue = z.union([
  z.string(), z.number(), z.boolean(),
  // (`{codes, other}` before `{other}`: an object schema strips unknown keys, so a multiple choice with Other would
  // otherwise read as `{other}` alone and lose its codes)
  z.object({ codes: z.array(z.string()), other: z.string().optional() }),
  z.object({ code: z.string() }), z.object({ other: z.string() }),
  // (a matrix's `{rows}` before the contact object, whose every field is optional: it would read any object as an empty contact)
  z.object({ rows: z.record(z.string(), z.string()) }),
  z.object({ name: optionalText, email: optionalText, phone: optionalText, company: optionalText }),
])
export type AnswerValue = z.infer<typeof answerValue>

const response = z.object({
  response_id: z.string().min(1),
  submitted_at: z.string().catch(''),
  form_revision: z.number().int().nullable().catch(null),
  language: z.string().catch(''),
  answers: recordOf(answerValue),
  hidden: z.record(z.string(), z.string()).catch({}),
  ending_id: z.string().catch(''),
  is_test: z.boolean().catch(false),
  feedback_id: optionalText,
})
export type FormResponse = z.infer<typeof response>

const page = z.object({
  responses: listOf(response),
  next_cursor: z.string().min(1).nullable().catch(null).optional().transform((cursor) => cursor ?? null),
})
export type ResponsesPage = z.infer<typeof page>

export function parseResponsesPage(raw: unknown): ResponsesPage {
  return page.parse(typeof raw === 'object' && raw !== null ? raw : {})
}
