/**
 * @fileoverview The forms builder's requests (7.55.00, docs/feedback-forms.md), with
 * every request and response shape in one place so they can be reconciled with the backend's (part A).
 *
 * - `GET /feedback-forms/{id}` → `{form}`: the stored form (v2; a v1 record, served migrated with `migrated_from:
 *   1`, is also migrated here as the server would) with its `revision`, `write_count` (every save counts one),
 *   `retired_ids` (the removed questions' ids, never taken again), `updated_by`, `has_responses` and
 *   `response_count` (the real responses `GET …/stats` counts; only this read carries it) and
 *   `can_delete_test_responses` (an admin or the form's creator: owner decision 2026-11-18). When the count is
 *   missing (`stats_error`), or the server has no such route (403/404/405: read from `GET /feedback-forms`' list
 *   instead), `GET …/stats`' `total_submissions` is asked for it: what locks codes and ids (D9).
 * - `POST /feedback-forms` (create, Off) and `PUT /feedback-forms/{id}` (save, with `expected_revision` and
 *   `expected_write_count`) → `{form}`, without `response_count` (the builder keeps the count it read:
 *   useFormDraft.ts). A stale save (another save came in between, whatever it changed) is a 409 `{code:
 *   'revision_conflict', revision, write_count, updated_by, updated_at}` (D7); a 400 may carry `errors: [{message,
 *   question_id?}]`, and a retired id taken again is a 400 `{code: 'question_id_reused', question_id}`. On a form with
 *   a real response, a save names in `removes` (`{questions?, options?: {question_id: codes}}`, model/removals.ts)
 *   every question id and option code it drops, and keeps every question's type and range; otherwise it is a 409
 *   `{code: 'answers_locked', questions, options, changed}` (D9, on the server too). No form answer carries the test
 *   token: `settings.test` says only whether one was issued (`token_issued`).
 * - `POST /feedback-forms/{id}/test-link` `{rotate?, link_enabled?, record?}` → `{test: {token, link_enabled,
 *   record}}`: the only answer that carries the test token (D2). `DELETE /feedback-forms/{id}/responses?test=true`
 *   → `{deleted}`.
 * - `GET /feedback-forms/{id}/results?…` (per-question aggregates and the funnel) and
 *   `GET /feedback-forms/{id}/responses?…` (paged responses; `include_test=only` for the Test tab, `format=csv` for
 *   the export), all with the Results filters and `include_test`; part A's shapes are read through
 *   feedbackFormsResultsAdapter.ts.
 * - `GET /feedback-forms/{id}/report?…` and `GET /feedback-forms/{id}/compare?…` (7.63.00, the Report, with the
 *   Results filters; feedbackFormsReport.ts reads them), and the report's AI summary, `POST /settings/form-reports`
 *   → 202 `{job_id}` polled at `GET /settings/form-reports/{job_id}` as the drafts are.
 * - `POST /settings/form-drafts` `{description, language, channel, base_form?, instruction?}` → 202 `{job_id}`,
 *   polled at `GET /settings/form-drafts/{job_id}` until `{form, notes, warnings}` (feedbackFormsDraftJob.ts): the
 *   settings API's, beside its assist worker, not the forms API's (whose Lambda also serves the public widget). A
 *   job's `invalid_draft` is a 422 with the validator's `errors`, its `no_model` a 503; the start refuses with 429
 *   `rate_limited` (`retry_after` seconds) or 403.
 *
 * The requests go through this module's own `fetchApi`: the app's transport (`api/client.ts`), except that a refusal
 * keeps the fields the forms routes add (`errors`, `retry_after`, the stale revision) on a {@link FormsApiError}.
 *
 * @module api/feedbackFormsV2Api
 */
import { z } from 'zod'
import i18n from 'i18next'
import { fetchApi as appFetchApi } from './client'
import { getAuthHeaders, getBaseUrl } from './baseUrl'
import { post, put, del } from './requestKit'
import { UPDATED_STAMP } from './schemaList'
import { ApiError, AuthError } from '../lib/errors'
import { parseFormV2, toWireForm } from '../pages/FeedbackForms/model/formsV2Schema'
import { migrateV1Form } from '../pages/FeedbackForms/model/migrateV1'
import type { Channel, FormLanguage, FormV2, LoadedForm, StoredFormMeta } from '../pages/FeedbackForms/model/formsV2'
import type { FormRemovals } from '../pages/FeedbackForms/model/removals'
import { isFormLanguage } from '../pages/FeedbackForms/model/formsV2'
import { parseFormResults, parseResponsesPage } from './feedbackFormsV2Results'
import { adaptResponsesPage, adaptResults } from './feedbackFormsResultsAdapter'
import type { FormResults, ResponsesPage } from './feedbackFormsV2Results'
import { settleDraft } from './feedbackFormsDraftJob'
import { FAMILIAR_CSV, dispositionFilename, csvParams } from './feedbackFormsCsv'
import type { CsvChoice, CsvFile } from './feedbackFormsCsv'
import { parseFormComparison, parseFormReport } from './feedbackFormsReport'
import type { FormComparison, FormReport, SummaryAnswer } from './feedbackFormsReport'

/** A refusal from a forms route, with what its body says beyond the message. */
export class FormsApiError extends ApiError {
  /** The validator's messages (a 400 on save, a 422 on an AI draft). */
  readonly errors: readonly FormsFieldError[]
  /** A 429's wait, in seconds, when the server said. */
  readonly retryAfterSeconds: number | null
  /** A 409's stored revision and who saved it, when the server said. */
  readonly current: { readonly revision: number | null; readonly updatedBy: string; readonly updatedAt: string } | null
  /** The question a refusal names (`question_id`: a retired id taken again, an answer refused), when it names one. */
  readonly questionId: string | null

  constructor(status: number, message: string | undefined, code: string | undefined, extra: FormsErrorExtra) {
    super(status, message, code)
    this.name = 'FormsApiError'
    this.errors = extra.errors
    this.retryAfterSeconds = extra.retryAfterSeconds
    this.current = extra.current
    this.questionId = extra.questionId ?? null
  }
}

export interface FormsFieldError {
  readonly message: string
  readonly questionId?: string
}

interface FormsErrorExtra {
  readonly errors: readonly FormsFieldError[]
  readonly retryAfterSeconds: number | null
  readonly current: FormsApiError['current']
  readonly questionId?: string | null
}

const MAX_ERRORS = 50
const fieldError = z.union([
  z.string().min(1).transform((message): FormsFieldError => ({ message })),
  z.object({ message: z.string().min(1), question_id: z.string().optional().catch(undefined) })
    .transform((e): FormsFieldError => (e.question_id === undefined ? { message: e.message } : { message: e.message, questionId: e.question_id })),
])
const errorBody = z.object({
  message: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional().catch(undefined),
  errors: z.array(z.unknown()).max(MAX_ERRORS).catch([]).transform((items) => items.flatMap((item) => {
    const parsed = fieldError.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })),
  retry_after: z.coerce.number().nonnegative().optional().catch(undefined),
  revision: z.number().int().optional().catch(undefined),
  question_id: z.string().max(64).optional().catch(undefined),
  ...UPDATED_STAMP,
})

type ErrorBody = z.infer<typeof errorBody>

/** The body of a refusal, or an empty one (no body, not JSON, already read). */
async function refusalBodyOf(response: Response): Promise<ErrorBody> {
  try {
    const parsed = errorBody.safeParse(JSON.parse(await response.text()))
    return parsed.success ? parsed.data : errorBody.parse({})
  } catch {
    return errorBody.parse({})
  }
}

/** A 429's wait: the body's `retry_after`, else the `Retry-After` header, else unknown. */
function retryAfterOf(response: Response, body: ErrorBody): number | null {
  const header = Number(response.headers.get('Retry-After') ?? '')
  return body.retry_after ?? (Number.isFinite(header) && header > 0 ? header : null)
}

async function formsErrorFor(response: Response): Promise<FormsApiError> {
  const body = await refusalBodyOf(response)
  const current = response.status === 409
    ? { revision: body.revision ?? null, updatedBy: body.updated_by ?? '', updatedAt: body.updated_at ?? '' } : null
  return new FormsApiError(response.status, (body.message ?? body.error)?.slice(0, 300), body.code,
    { errors: body.errors, retryAfterSeconds: retryAfterOf(response, body), current, questionId: body.question_id ?? null })
}

/**
 * This module's requests: the app's headers (the token only to a trusted origin, the workspace header), a 401
 * handed to the app's transport (which refreshes the session and retries once), and a refusal as a FormsApiError.
 */
async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${endpoint}`
  const response = await fetch(url, { ...options, headers: getAuthHeaders(url) })
  if (response.status === 401) return appFetchApi<T>(endpoint, options)
  if (!response.ok) throw await formsErrorFor(response)
  const body: unknown = await response.json()
  return z.custom<T>(() => true).parse(body)
}

const metaSchema = z.object({
  form_id: z.string().min(1),
  revision: z.number().int().nonnegative().catch(0),
  write_count: z.number().int().nonnegative().catch(0),
  retired_ids: z.array(z.string()).max(1000).catch([]),
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
  updated_by: z.string().catch(''),
  has_responses: z.boolean().catch(false),
  response_count: z.number().int().nonnegative().catch(0),
  can_delete_test_responses: z.boolean().catch(false),
  schema_version: z.number().catch(1),
  migrated_from: z.number().optional().catch(undefined),
  language_unconfirmed: z.boolean().catch(false),
  // (part A's name for D15's flag: the primary was assumed from the deployment default)
  language_assumed: z.boolean().catch(false),
})

/** The deployment's default language for a v1 form without one (D15): the app's UI language. */
function deploymentLanguage(): FormLanguage {
  const language = i18n.language.split('-')[0] ?? ''
  return isFormLanguage(language) ? language : 'en'
}

const migrationCopy = (key: 'tellUsMore' | 'contactHeadline', lng: FormLanguage) =>
  i18n.t(`feedbackForms:migration.${key}`, { lng })

/** A stored form as the builder edits it; null when the record has no id. */
export function parseStoredForm(raw: unknown): LoadedForm | null {
  const meta = metaSchema.safeParse(raw)
  if (!meta.success) return null
  const isV2 = meta.data.schema_version === 2
  const migrated = isV2 ? null : migrateV1Form(raw, deploymentLanguage(), migrationCopy)
  const form = migrated?.form ?? parseFormV2(raw)
  if (form === null) return null
  const stored: StoredFormMeta = {
    form_id: meta.data.form_id,
    revision: meta.data.revision,
    write_count: meta.data.write_count,
    retired_ids: meta.data.retired_ids,
    created_at: meta.data.created_at,
    updated_at: meta.data.updated_at,
    updated_by: meta.data.updated_by,
    has_responses: meta.data.has_responses || meta.data.response_count > 0,
    response_count: meta.data.response_count,
    can_delete_test_responses: meta.data.can_delete_test_responses,
    migrated_from_v1: migrated !== null || meta.data.migrated_from === 1,
    language_unconfirmed: migrated?.languageUnconfirmed ?? (meta.data.language_unconfirmed || meta.data.language_assumed),
  }
  return { form, meta: stored }
}

const formAnswer = z.object({ form: z.unknown() })

function loadedFrom(raw: unknown): LoadedForm {
  const body = formAnswer.safeParse(raw)
  const loaded = body.success ? parseStoredForm(body.data.form) : null
  if (loaded === null) throw new ApiError(502, 'The server answered without a form.')
  return loaded
}

const formPath = (formId: string) => `/feedback-forms/${encodeURIComponent(formId)}`

/** A route this API may not have yet (an older or a v1 server): API Gateway and the router answer 403/404/405. */
const isMissingRoute = (error: unknown): boolean => error instanceof ApiError && [403, 404, 405].includes(error.status)

const formsList = z.object({ forms: z.array(z.unknown()).catch([]) })
const formStats = z.object({ stats: z.object({ total_submissions: z.number().int().nonnegative().catch(0) }).catch({ total_submissions: 0 }) })

/** The stored form: `GET /feedback-forms/{id}`, else (a server without that route) the list's record of it. */
async function readFormRecord(formId: string): Promise<unknown> {
  try {
    const answer = formAnswer.parse(await fetchApi<unknown>(formPath(formId)))
    return answer.form
  } catch (error) {
    if (!isMissingRoute(error)) throw error
    const listed = formsList.parse(await fetchApi<unknown>('/feedback-forms')).forms
    const found = listed.find((form) => typeof form === 'object' && form !== null && Reflect.get(form, 'form_id') === formId)
    if (found === undefined) throw new FormsApiError(404, 'Form not found', 'not_found', { errors: [], retryAfterSeconds: null, current: null })
    return found
  }
}

/** Did the record come with its response count (`GET /feedback-forms/{id}` sends one unless it could not count)? */
const countedRecord = z.object({ response_count: z.number().int().nonnegative() })

/** How many real responses the form has (its stats; 0 when they can't be read): codes and ids lock from the first. */
async function readResponseCount(formId: string): Promise<number> {
  try {
    return formStats.parse(await fetchApi<unknown>(`${formPath(formId)}/stats`)).stats.total_submissions
  } catch (error) {
    console.warn('The form\'s response count could not be read:', error)
    return 0
  }
}

async function readStoredForm(formId: string): Promise<LoadedForm> {
  const record = await readFormRecord(formId)
  const loaded = parseStoredForm(record)
  if (loaded === null) throw new ApiError(502, 'The server answered without a form.')
  if (countedRecord.safeParse(record).success) return loaded
  const count = Math.max(loaded.meta.response_count, await readResponseCount(formId))
  return { ...loaded, meta: { ...loaded.meta, response_count: count, has_responses: loaded.meta.has_responses || count > 0 } }
}

/** The Results filters, as the URL holds them (UX §10.1). */
export interface ResultsFilters {
  /** Days back from now; null: all time. */
  readonly days: number | null
  readonly language: string
  readonly ending: string
  readonly hidden: Readonly<Record<string, string>>
  readonly includeTest: boolean
}

function filterQuery(filters: ResultsFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra)
  if (filters.days !== null) params.set('from', new Date(Date.now() - filters.days * 86_400_000).toISOString())
  if (filters.language !== '') params.set('language', filters.language)
  if (filters.ending !== '') params.set('ending', filters.ending)
  for (const [id, value] of Object.entries(filters.hidden)) params.set(`hidden.${id}`, value)
  params.set('include_test', filters.includeTest ? 'true' : 'false')
  return params.toString()
}

const testLink = z.object({
  test: z.object({ token: z.string().min(1), link_enabled: z.boolean().catch(true), record: z.enum(['tag', 'drop']).catch('tag') }),
})
/** The test link's state as `POST …/test-link` answers it (the only answer that carries the token). */
export interface TestLinkState {
  readonly token: string
  readonly link_enabled: boolean
  readonly record: 'tag' | 'drop'
}
const deleted = z.object({ deleted: z.number().int().nonnegative().catch(0) })

/** The AI draft's request (contract "Describe it, and the AI builds the form"). */
export interface DraftRequest {
  readonly description: string
  readonly language: FormLanguage
  readonly channel: Channel
  readonly base_form?: FormV2
  readonly instruction?: string
}

/** A model note or warning; `target` is the question or ending it names, when it names one. */
export interface DraftNote {
  readonly message: string
  readonly target?: string
}

export interface DraftAnswer {
  readonly form: FormV2
  readonly notes: readonly DraftNote[]
  readonly warnings: readonly DraftNote[]
}

const note = z.union([
  z.string().min(1).transform((message): DraftNote => ({ message })),
  z.object({ message: z.string().min(1), target: z.string().optional().catch(undefined) })
    .transform((n): DraftNote => (n.target === undefined ? { message: n.message } : { message: n.message, target: n.target })),
])
const notes = z.array(z.unknown()).catch([]).transform((items) => items.flatMap((item) => {
  const parsed = note.safeParse(item)
  return parsed.success ? [parsed.data] : []
}))
const draftAnswer = z.object({ form: z.unknown(), notes, warnings: notes })

/** A draft job's refusal as the forms routes' own: 422 `invalid_draft` with the validator's errors, 503 `no_model`. */
function draftRefusal(status: number, code: string | undefined, message: string | undefined, errors: readonly unknown[]): FormsApiError {
  const fieldErrors = errors.flatMap((item) => {
    const parsed = fieldError.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  return new FormsApiError(status, message, code, { errors: fieldErrors, retryAfterSeconds: null, current: null })
}

/** What the report's AI summary is asked for: the answers read, and the view they were read under. */
export interface SummaryRequest {
  readonly answers: readonly SummaryAnswer[]
  /** The view's filters as the query string names them (recorded with the summary). */
  readonly filters: Readonly<Record<string, string>>
  readonly responses: number
  readonly lastResponseAt: string | null
}

const summaryDone = z.object({ report_id: z.string().min(1) })

/** The Results filters as a summary records them: the query's own names, without `include_test`. */
export function summaryFilters(filters: ResultsFilters): Record<string, string> {
  const params = new URLSearchParams(filterQuery(filters))
  params.delete('include_test')
  return Object.fromEntries(params.entries())
}

function parseDraft(raw: unknown): DraftAnswer {
  const body = draftAnswer.safeParse(raw)
  const form = body.success ? parseFormV2(body.data.form) : null
  if (!body.success || form === null) throw new ApiError(502, 'The AI draft came back without a form.')
  return { form: { ...form, enabled: false }, notes: body.data.notes, warnings: body.data.warnings }
}

export const feedbackFormsV2Api = {
  /** The stored form, with its real-response count (from its stats) so the editor knows what is locked (D9). */
  getForm: (formId: string): Promise<LoadedForm> => readStoredForm(formId),

  /** Create the form (always Off: publishing is a separate save). Its creator may delete its test responses. */
  createForm: (form: FormV2): Promise<LoadedForm> =>
    fetchApi<unknown>('/feedback-forms', post({ ...toWireForm(form), enabled: false })).then(loadedFrom)
      .then((created) => ({ ...created, meta: { ...created.meta, can_delete_test_responses: true } })),

  /**
   * Save the form over `expectedRevision` (and `expectedWriteCount`, the save count it was read at: any save since is
   * a 409), naming what it `removes` from an answered form (model/removals.ts); a 409 (FormsApiError) when another
   * save won (D7, `revision_conflict`) or a removal went unnamed or a type changed (`answers_locked`).
   */
  saveForm: (formId: string, form: FormV2, expectedRevision: number, removes: FormRemovals | null = null,
    expectedWriteCount: number | null = null): Promise<LoadedForm> =>
    fetchApi<unknown>(formPath(formId), put({
      ...toWireForm(form), expected_revision: expectedRevision, ...(removes === null ? {} : { removes }),
      ...(expectedWriteCount === null ? {} : { expected_write_count: expectedWriteCount }),
    })).then(loadedFrom),

  /** Turn the form on or off (the list's switch, Turn off): only `enabled` changes, over what the caller read. */
  setEnabled: (formId: string, enabled: boolean, expectedRevision?: number, expectedWriteCount?: number): Promise<LoadedForm> =>
    fetchApi<unknown>(formPath(formId), put({
      enabled, ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
      ...(expectedWriteCount === undefined ? {} : { expected_write_count: expectedWriteCount }),
    })).then(loadedFrom),

  /**
   * The test link (D2): `POST …/test-link` issues it (or rotates it, `rotate`), sets `link_enabled` / `record` when
   * given, and answers the token, which no other route returns.
   */
  issueTestLink: (formId: string, body: { rotate?: boolean; link_enabled?: boolean; record?: 'tag' | 'drop' } = {}): Promise<TestLinkState> =>
    fetchApi<unknown>(`${formPath(formId)}/test-link`, post(body)).then((raw) => testLink.parse(raw).test),

  /**
   * A new test token: the old test link stops working (D2). `keep`: the stored form's test settings, sent back as they
   * are, so the reset never turns the saved link on or changes how it records (only Save does).
   */
  rotateTestToken: (formId: string, keep: { link_enabled: boolean; record: 'tag' | 'drop' }): Promise<string> =>
    fetchApi<unknown>(`${formPath(formId)}/test-link`, post({ rotate: true, ...keep })).then((raw) => testLink.parse(raw).test.token),

  /** Delete every test response of the form (D2); resolves to how many went. */
  deleteTestResponses: (formId: string): Promise<number> =>
    fetchApi<unknown>(`${formPath(formId)}/responses?test=true`, del()).then((raw) => deleted.parse(raw).deleted),

  getResults: (formId: string, filters: ResultsFilters): Promise<FormResults> =>
    fetchApi<unknown>(`${formPath(formId)}/results?${filterQuery(filters)}`).then((raw) => parseFormResults(adaptResults(raw))),

  /** One page of responses (newest first). `testOnly`: the Test tab's recent test responses. */
  getResponses: (formId: string, filters: ResultsFilters, page: { cursor?: string; limit: number; testOnly?: boolean }): Promise<ResponsesPage> => {
    const extra: Record<string, string> = { limit: String(page.limit) }
    if (page.cursor !== undefined) extra['cursor'] = page.cursor
    const query = new URLSearchParams(filterQuery(filters, extra))
    // (part A: `include_test=only` is the Test tab's list)
    if (page.testOnly === true) query.set('include_test', 'only')
    return fetchApi<unknown>(`${formPath(formId)}/responses?${query.toString()}`).then((raw) => parseResponsesPage(adaptResponsesPage(raw)))
  },

  /** The responses as CSV (api/feedbackFormsCsv.ts): the familiar layout unless `choice` says detailed, under the filters. */
  downloadResponsesCsv: async (formId: string, filters: ResultsFilters, choice: CsvChoice = FAMILIAR_CSV): Promise<CsvFile> => {
    const url = `${getBaseUrl()}${formPath(formId)}/responses?${filterQuery(filters, csvParams(choice))}`
    // (the address spelled out again in the call: the mock-coverage gate reads a request's address from its text)
    const response = await fetch(`${getBaseUrl()}${formPath(formId)}/responses?${filterQuery(filters, csvParams(choice))}`, { method: 'GET', headers: getAuthHeaders(url) })
    if (response.status === 401) throw new AuthError()
    if (!response.ok) throw await formsErrorFor(response)
    return { blob: await response.blob(), filename: dispositionFilename(response.headers.get('Content-Disposition')) }
  },

  /** The form's Report under the Results filters (7.63.00), grouped by `groupBy` (`hidden.<id>`, `q_<id>`,
   * `q_<id>.<row>`) when given. */
  getReport: (formId: string, filters: ResultsFilters, groupBy: string | null): Promise<FormReport> =>
    fetchApi<unknown>(`${formPath(formId)}/report?${filterQuery(filters, groupBy === null ? {} : { group_by: groupBy })}`)
      .then(parseFormReport),

  /** The form beside up to 10 others (`withIds`), split by a hidden field (`by`) when given. */
  compareForms: (formId: string, filters: ResultsFilters, withIds: readonly string[], by: string | null): Promise<FormComparison> => {
    const extra: Record<string, string> = withIds.length === 0 ? {} : { with: withIds.join(',') }
    if (by !== null) extra['by'] = by
    return fetchApi<unknown>(`${formPath(formId)}/compare?${filterQuery(filters, extra)}`).then(parseFormComparison)
  },

  /**
   * The report's AI summary of `request.answers` (read by the caller with their own access): a 202 job polled until it
   * ends; resolves to the stored report's id (the report then carries the summary). `signal` stops the wait.
   */
  summarizeReport: (formId: string, request: SummaryRequest, signal?: AbortSignal): Promise<string> =>
    fetchApi<unknown>('/settings/form-reports', {
      ...post({ form_id: formId, answers: request.answers, filters: request.filters, responses: request.responses,
        last_response_at: request.lastResponseAt }),
      // (spelled out as well: the mock-coverage gate reads a request's method from its options' text)
      method: 'POST',
      signal,
    }).then((raw) => settleDraft(raw, (jobId) => fetchApi<unknown>(`/settings/form-reports/${encodeURIComponent(jobId)}`, { method: 'GET', signal }),
      draftRefusal, signal))
      .then((raw) => summaryDone.parse(raw).report_id),

  /**
   * Ask the AI for a form (or for changes to `base_form`): never saved, never published. `signal` cancels it. The
   * server answers a 202 job the browser polls until it ends (feedbackFormsDraftJob.ts).
   */
  draftForm: (request: DraftRequest, signal?: AbortSignal): Promise<DraftAnswer> =>
    fetchApi<unknown>('/settings/form-drafts', {
      ...post({
        description: request.description,
        language: request.language,
        channel: request.channel,
        ...(request.base_form === undefined ? {} : { base_form: toWireForm(request.base_form) }),
        ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
      }),
      // (spelled out as well: the mock-coverage gate reads a request's method from its options' text)
      method: 'POST',
      signal,
    }).then((raw) => settleDraft(raw, (jobId) => fetchApi<unknown>(`/settings/form-drafts/${encodeURIComponent(jobId)}`, { method: 'GET', signal }),
      draftRefusal, signal))
      .then(parseDraft),
}
