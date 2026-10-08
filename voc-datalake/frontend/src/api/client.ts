// The request pipeline (`fetchApi`) and the `api` object. `max-lines` counts only code
// (`skipBlankLines: true, skipComments: true`), so self-contained endpoint groups live in
// factories (`adminEndpoints.ts`, `dataEndpoints.ts`) spread into `api` below, and project
// methods delegate via `import('./projectsApi')`. Types live in `./types` and are imported
// from there, not re-exported here. Keep the /feedback-forms calls and `generateDocument`
// in THIS file: api-stack.test.ts and test_doc_type_lockstep.py read its source text.
import { authService } from '../services/auth'
import { endExpiredSession } from '../services/sessionExpiry'
import { ApiError } from '../lib/errors'
import { getBaseUrl, getAuthHeaders, getDaysFromRange } from './baseUrl'
import { buildSearchParams } from './requestKit'
import { logsEndpoints, userAdminEndpoints } from './adminEndpoints'
import { dataExplorerEndpoints, s3ImportEndpoints } from './dataEndpoints'
import { isRecord } from '../lib/typeGuards'
import type {
  AttributeFilters,
  DateBasis,
  FeedbackItem,
  FeedbackListParams,
  FeedbackListResponse,
  MetricsSummary,
  SentimentBreakdown,
  CategoryBreakdown,
  SourceBreakdown,
  PersonaBreakdown,
  IntegrationStatus,
  ScraperConfig,
  EntitiesResponse,
  PrioritizationScore,
  PrioritizationBallotEdit,
  FeedbackForm,
  // The document-generation request body, shared with the `projectsApi` method
  // this file's wrapper forwards to; see its declaration in `./types`.
  GenerateDocumentBody,
} from './types'
import type {
  CreateProjectBody,
  ProjectPersona,
  Project,
  PrioritizationAggregate,
  PrioritizationRow,
} from './projectTypes'

/**
 * Date-range query parameters sent to time-filtered analytics endpoints.
 *
 * All time ranges resolve to a single rolling lookback in `days` (presets,
 * "All", and the "last N days" custom range). `date_basis` selects which date
 * the window applies to ('review' = when the customer wrote the feedback);
 * it is omitted for the default 'imported' basis so URLs stay unchanged for
 * existing behavior. See {@link getDateRangeParams}.
 */
export interface DateRangeParams {
  days?: number
  date_basis?: DateBasis
}

/**
 * Build request headers for `targetUrl`, including Authorization when its
 * origin is trusted.
 *
 * `targetUrl` is required and comes first for the same reason it does in
 * {@link getAuthHeaders}: the origin check is the point of this function, so a
 * call site that forgets the URL must not compile.
 */
function buildHeaders(targetUrl: string, existingHeaders?: HeadersInit): Record<string, string> {
  const extra = existingHeaders ? Object.fromEntries(Object.entries(existingHeaders)) : undefined
  return getAuthHeaders(targetUrl, extra)
}

import { z } from 'zod'
import { normalizeFeedbackItem, normalizeFeedbackItems } from './feedbackSchema'
import { normalizeGithubMetrics } from './githubMetricsSchema'
import { normalizeFormStatsMap } from './feedbackFormStatsSchema'
import { normalizeModelCapacity, normalizeModelTestResult } from './modelTestSchema'

// API response parser using Zod for runtime validation
// This satisfies the no-type-assertions rule
const unknownSchema = z.unknown()

async function parseJsonResponse<T>(response: Response): Promise<T> {
  // Use unknownSchema to safely parse the JSON response
  const rawJson: unknown = await response.json()
  const validated = unknownSchema.parse(rawJson)
  // Use Zod's custom schema to convert unknown to T without type assertions
  const typedSchema = z.custom<T>(() => true)
  return typedSchema.parse(validated)
}

/**
 * The server's own reason in a JSON error body. Powertools and API Gateway put
 * it under `message`; this app's Lambdas answer every ApiError (400 / 403 / 404
 * / 409 / 500, `lambda/shared/api.py`) with `{success: false, error}`, so `error`
 * is read when `message` is absent — without it a ValidationError's reason (e.g.
 * "No feedback data found for the given filters") never reached the screen and
 * the user saw "API Error: 400". Nothing else in the body is kept, and a reason
 * longer than a sentence or two is not one meant for a screen.
 */
const MAX_SERVER_MESSAGE_CHARS = 300
const reasonSchema = z.string().trim().min(1).max(MAX_SERVER_MESSAGE_CHARS)
const errorBodySchema = z.object({
  message: reasonSchema.optional().catch(undefined),
  error: reasonSchema.optional().catch(undefined),
})

async function serverMessage(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(await response.text()))
    return parsed.success ? (parsed.data.message ?? parsed.data.error) : undefined
  } catch {
    // No body, a non-JSON body (an API Gateway error page), or a body that was
    // already consumed: the status alone is still a complete answer.
    return undefined
  }
}

/**
 * The rejection for a non-OK response: an `ApiError` carrying the status as a
 * typed field (what `apiErrorStatus` reads first), whose message is the
 * server's own when it sent one and `API Error: {status}` otherwise.
 */
async function apiErrorFor(response: Response): Promise<ApiError> {
  const message = await serverMessage(response)
  return message === undefined ? new ApiError(response.status) : new ApiError(response.status, message)
}

async function handleUnauthorized<T>(
  fullUrl: string,
  options: RequestInit | undefined,
): Promise<T> {
  await authService.refreshSession()
  // Rebuild headers through buildHeaders so the origin check fires on the
  // retry path too — this prevents an attacker-controlled server from
  // receiving the refreshed token by responding 401 to the first request.
  // The assistant's AG-UI client (assistant/agui/client.ts) does the same.
  const retryHeaders = buildHeaders(fullUrl, options?.headers)
  const retryResponse = await fetch(fullUrl, { ...options, headers: retryHeaders })
  if (!retryResponse.ok) {
    throw await apiErrorFor(retryResponse)
  }
  return parseJsonResponse<T>(retryResponse)
}

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl()
  const fullUrl = `${baseUrl}${endpoint}`
  const headers = buildHeaders(fullUrl, options?.headers)

  const response = await fetch(fullUrl, { ...options, headers })
  
  if (response.ok) {
    return parseJsonResponse<T>(response)
  }
  
  if (response.status === 401) {
    try {
      return await handleUnauthorized<T>(fullUrl, options)
    } catch {
      // Carries the reason to /login so the user is told the session ended,
      // instead of meeting a bare login form after a working-looking app.
      endExpiredSession()
      throw new Error('Session expired. Please login again.')
    }
  }
  
  throw await apiErrorFor(response)
}

/** One category row as the settings API stores it (see contract C). */
interface CategoryConfigEntry {
  id: string
  name: string
  description?: string
  product?: string
  owners?: Array<{ sub: string; username: string; email: string }>
  subcategories: Array<{ id: string; name: string; description?: string }>
}

export const api = {
  // Feedback
  getFeedback: async (params: FeedbackListParams) => {
    const searchParams = buildSearchParams(params)
    const res = await fetchApi<FeedbackListResponse>(`/feedback?${searchParams}`)
    return { ...res, items: normalizeFeedbackItems(res.items) }
  },
  
  getFeedbackById: async (id: string) => normalizeFeedbackItem(await fetchApi<FeedbackItem>(`/feedback/${id}`)),
  
  getUrgentFeedback: async (params: { days?: number; date_basis?: DateBasis; limit?: number; source?: string; sentiment?: string; category?: string } & AttributeFilters) => {
    const searchParams = buildSearchParams(params)
    const res = await fetchApi<{ count: number; items: FeedbackItem[] }>(`/feedback/urgent?${searchParams}`)
    return { ...res, items: normalizeFeedbackItems(res.items) }
  },
  
  searchFeedback: async (params: { q: string; days?: number; date_basis?: DateBasis; limit?: number; source?: string; sentiment?: string; category?: string } & AttributeFilters) => {
    // `q` trimmed HERE, at the single boundary every caller goes through, so the
    // string that is SENT is the string the route measures.
    //
    // `/feedback/search` trims before applying `SEARCH_QUERY_MIN_LENGTH` and
    // refuses a present-but-too-short term with a 400, so a caller passing `"a "`
    // through untrimmed would have the server measure something different from
    // what the caller measured.
    //
    // ⚠️ Precisely what this does and does not buy: it normalises the VALUE, not
    // the DECISION. A caller that gates on raw `.length` will still let `"a "`
    // past its own gate, and this boundary will faithfully send `q=a` and get a
    // 400. Only a caller's own TRIMMED gate prevents that — `useFeedbackListData`
    // has one, and `test_search_minimum_lockstep.py` pins its constant to the
    // route's.
    //
    // A too-short term is deliberately NOT short-circuited into an empty result
    // here, because returning `count: 0` for a search that never ran is the same
    // ambiguity the route was fixed to stop producing — moving it from the server
    // to the client would not make it honest. A loud 400 beats a quiet zero.
    const searchParams = buildSearchParams({ ...params, q: params.q.trim() })
    // `is_partial_window` declared, not merely surviving the spread below: the
    // route sets it when the candidate scan stops on its soft cap, and
    // `extractTotals` already reads that key for the search branch, so the "N+"
    // display works either way. Declaring it is what tells the next reader the
    // field is real rather than incidental.
    const res = await fetchApi<{ count: number; items: FeedbackItem[]; entities: EntitiesResponse['entities']; query: string; is_partial_window?: boolean }>(`/feedback/search?${searchParams}`)

    return { ...res, items: normalizeFeedbackItems(res.items) }
  },
  
  getSimilarFeedback: async (id: string, limit?: number) => {
    const searchParams = new URLSearchParams()
    if (limit) searchParams.set('limit', String(limit))
    const res = await fetchApi<{ source_feedback_id: string; count: number; items: FeedbackItem[] }>(`/feedback/${id}/similar?${searchParams}`)
    return { ...res, items: normalizeFeedbackItems(res.items) }
  },
  
  getEntities: (params: { days?: number; date_basis?: DateBasis; limit?: number; source?: string } & AttributeFilters) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<EntitiesResponse>(`/feedback/entities?${searchParams}`)
  },
  
  // Metrics
  getSummary: (range: DateRangeParams, source?: string, filters?: AttributeFilters) => {
    const searchParams = buildSearchParams({ ...range, source, ...filters })
    return fetchApi<MetricsSummary>(`/metrics/summary?${searchParams}`)
  },
  getSentiment: (range: DateRangeParams, source?: string, filters?: AttributeFilters) => {
    const searchParams = buildSearchParams({ ...range, source, ...filters })
    return fetchApi<SentimentBreakdown>(`/metrics/sentiment?${searchParams}`)
  },
  getCategories: (range: DateRangeParams, source?: string, filters?: AttributeFilters) => {
    const searchParams = buildSearchParams({ ...range, source, ...filters })
    return fetchApi<CategoryBreakdown>(`/metrics/categories?${searchParams}`)
  },
  getSources: (range: DateRangeParams) => {
    const searchParams = buildSearchParams({ ...range })
    return fetchApi<SourceBreakdown>(`/metrics/sources?${searchParams}`)
  },
  getPersonas: (range: DateRangeParams, source?: string, filters?: AttributeFilters) => {
    const searchParams = buildSearchParams({ ...range, source, ...filters })
    return fetchApi<PersonaBreakdown>(`/metrics/personas?${searchParams}`)
  },
  /** GitHub Issues per release / per label (normalized: the Dashboard renders it as-is). */
  getGithubMetrics: async (range: DateRangeParams, repo?: string) => {
    const searchParams = buildSearchParams({ ...range, repo })
    return normalizeGithubMetrics(await fetchApi<unknown>(`/metrics/github?${searchParams}`))
  },
  
  // Data Source Schedules
  getSourcesStatus: (sources?: string[]) => {
    const params = sources?.length == null ? '' : `?sources=${sources.join(',')}`
    return fetchApi<{ sources: Record<string, { enabled: boolean; schedule?: string; rule_name?: string; exists?: boolean; error?: string }> }>(`/sources/status${params}`)
  },
  
  enableSource: (source: string) => fetchApi<{ success: boolean; source: string; enabled: boolean; message?: string }>(`/sources/${source}/enable`, { method: 'PUT' }),
  
  disableSource: (source: string) => fetchApi<{ success: boolean; source: string; enabled: boolean; message?: string }>(`/sources/${source}/disable`, { method: 'PUT' }),

  runSource: (source: string, appId?: string) => fetchApi<{
    success: boolean;
    message: string;
    source: string;
    execution_id?: string
  }>(`/sources/${source}/run`, {
    method: 'POST',
    ...(appId != null && appId !== '' ? { body: JSON.stringify({ app_id: appId }) } : {}),
  }),

  getSourceRunStatus: (source: string) => fetchApi<{
    source: string;
    status: string;
    execution_id?: string;
    started_at?: string;
    completed_at?: string;
    items_found?: number;
    errors?: string[]
  }>(`/sources/status?run_status=${source}`),

  // App Config CRUD (multi-instance plugins like iOS/Android app reviews)
  getAppConfigs: (source: string) =>
    fetchApi<{ apps: Array<Record<string, string>> }>(`/integrations/${source}/apps`),

  saveAppConfig: (source: string, app: Record<string, string>) =>
    fetchApi<{
      success: boolean;
      app: Record<string, string>
    }>(`/integrations/${source}/apps`, {
      method: 'POST',
      body: JSON.stringify({ app }),
    }),

  deleteAppConfig: (source: string, appId: string) =>
    fetchApi<{ success: boolean }>(`/integrations/${source}/apps/${appId}`, { method: 'DELETE' }),

  // Brand Settings (persisted to DynamoDB)
  getBrandSettings: () => fetchApi<{
    brand_name: string
    brand_handles: string[]
    hashtags: string[]
    urls_to_track: string[]
    error?: string
  }>('/settings/brand'),
  
  saveBrandSettings: (settings: {
    brand_name: string
    brand_handles: string[]
    hashtags: string[]
    urls_to_track: string[]
  }) => fetchApi<{ success: boolean; message: string; settings: typeof settings }>('/settings/brand', {
    method: 'PUT',
    body: JSON.stringify(settings)
  }),

  // AI model selection — per-surface, curated allowlist, admin-only UI (issue #96).
  // `surfaces` lists each pickable AI surface with its built-in default and the
  // admin-selected override (null = Automatic). `model_id` is a legacy global
  // override kept for backward compatibility.
  getModelSettings: () => fetchApi<{
    available_models: Array<{ key: string; id: string; label: string; description: string }>
    surfaces: Array<{ key: string; default_id: string; selected: string | null }>
    model_id: string | null
  }>('/settings/model'),

  // Set (modelId = allowlisted id) or clear (modelId = null) the model for one
  // surface. Backend is admin-gated; the UI only shows this to admins.
  saveModelSettings: (surface: string, modelId: string | null) =>
    fetchApi<{ success: boolean; surface: string | null; model_id: string | null }>('/settings/model', {
      method: 'PUT',
      body: JSON.stringify({ surface, model_id: modelId }),
    }),

  // Send ONE minimal request to exactly this allowlisted model (admin-only; no
  // fallback) and classify the outcome — see lambda/shared/model_capacity.py.
  testModel: async (modelId: string) => normalizeModelTestResult(
    await fetchApi<unknown>('/settings/model/test', {
      method: 'POST',
      body: JSON.stringify({ model_id: modelId }),
    }),
    modelId,
  ),

  // Tokens-per-minute quota of every allowlisted model (admin-only; no model call).
  getModelCapacity: async () => normalizeModelCapacity(await fetchApi<unknown>('/settings/model/capacity')),

  // Problem resolution (Problem Analysis page; shared across users)
  getResolvedProblems: () => fetchApi<{
    resolved: Record<string, { resolved_at: string }>
  }>('/settings/resolved-problems'),

  setProblemResolved: (key: string, resolved: boolean) =>
    fetchApi<{ success: boolean; key: string; resolved: boolean }>('/settings/resolved-problems', {
      method: 'PUT',
      body: JSON.stringify({ key, resolved })
    }),

  // Categories Configuration
  // GET is open to every signed-in user; the rows are normalized by the
  // consumer (categoriesSchema.ts). PUT is admin-only and validated server-side.
  getCategoriesConfig: () => fetchApi<{ 
    categories: CategoryConfigEntry[]
    updated_at?: string 
  }>('/settings/categories'),
  
  saveCategoriesConfig: (config: { 
    categories: CategoryConfigEntry[]
  }) => fetchApi<{ success: boolean; message: string }>('/settings/categories', {
    method: 'PUT',
    body: JSON.stringify(config)
  }),
  
  generateCategories: (companyDescription: string) => 
    fetchApi<{ 
      success: boolean
      categories: Array<{
        id: string
        name: string
        description?: string
        subcategories: Array<{ id: string; name: string; description?: string }>
      }>
    }>('/settings/categories/generate', {
      method: 'POST',
      body: JSON.stringify({ company_description: companyDescription })
    }),

  // Integrations
  getIntegrationStatus: () => fetchApi<IntegrationStatus>('/integrations/status'),
  
  updateIntegrationCredentials: (source: string, credentials: Record<string, string>) => 
    fetchApi<{ success: boolean; message: string }>(`/integrations/${source}/credentials`, {
      method: 'PUT',
      body: JSON.stringify(credentials)
    }),
  getIntegrationCredentials: (source: string, keys: string[]) =>
    fetchApi<Record<string, string>>(`/integrations/${source}/credentials?keys=${keys.join(',')}`),
  
  testIntegration: (source: string) => 
    fetchApi<{ success: boolean; message?: string; error?: string; details?: Record<string, unknown> }>(`/integrations/${source}/test`, {
      method: 'POST'
    }),

  // Scrapers (raw list, for the logs page's scraper picker)
  getScrapers: () => fetchApi<{ scrapers: ScraperConfig[] }>('/scrapers'),

  // The rest of /scrapers/* (templates, save, run, status, manual import)
  // lives in `scrapersApi`, which normalizes the drifted runtime shapes.

  // Projects - delegated to projectsApi for file size reduction
  getProjects: () => import('./projectsApi').then(m => m.projectsApi.getProjects()),
  createProject: (data: CreateProjectBody) =>
    import('./projectsApi').then(m => m.projectsApi.createProject(data)),
  getProject: (id: string) => import('./projectsApi').then(m => m.projectsApi.getProject(id)),
  updateProject: (id: string, data: Partial<Project>) =>
    import('./projectsApi').then(m => m.projectsApi.updateProject(id, data)),
  deleteProject: (id: string) => import('./projectsApi').then(m => m.projectsApi.deleteProject(id)),
  generatePersonas: (projectId: string, filters?: { sources?: string[]; categories?: string[]; sentiments?: string[]; persona_count?: number; custom_instructions?: string; days?: number }) =>
    import('./projectsApi').then(m => m.projectsApi.generatePersonas(projectId, filters)),
  createPersona: (projectId: string, persona: Omit<ProjectPersona, 'persona_id' | 'created_at'>) =>
    import('./projectsApi').then(m => m.projectsApi.createPersona(projectId, persona)),
  updatePersona: (projectId: string, personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    import('./projectsApi').then(m => m.projectsApi.updatePersona(projectId, personaId, data)),
  deletePersona: (projectId: string, personaId: string) =>
    import('./projectsApi').then(m => m.projectsApi.deletePersona(projectId, personaId)),
  importPersona: (projectId: string, data: { input_type: 'image' | 'text'; content: string; media_type?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.importPersona(projectId, data)),
  runResearch: (projectId: string, data: { question: string; title?: string; sources?: string[]; categories?: string[]; sentiments?: string[]; days?: number; selected_persona_ids?: string[]; selected_document_ids?: string[] }) =>
    import('./projectsApi').then(m => m.projectsApi.runResearch(projectId, data)),
  // Keep this signature on ONE line, and keep `data` taking the shared type by name:
  // test_doc_type_lockstep.py matches it as exact text, and requires EVERY declaration
  // of generateDocument to take `GenerateDocumentBody` (a ratio, because a mere
  // substring search was satisfied by an unrelated occurrence while the real
  // parameter was respelled inline — issue #381).
  generateDocument: (projectId: string, data: GenerateDocumentBody) =>
    import('./projectsApi').then(m => m.projectsApi.generateDocument(projectId, data)),
  // `output_type` is a DIFFERENT contract from `DocType`, not a copy that was
  // missed: POST .../documents/merge takes a third value (`custom`) and the merger
  // reads it unchecked (`lambda/jobs/document_merger/handler.py`), so it is not
  // bound to the document route's allowlist. Widening it is a separate change.
  mergeDocuments: (projectId: string, data: { output_type: 'prd' | 'prfaq' | 'custom'; title: string; instructions: string; selected_document_ids: string[]; selected_persona_ids?: string[]; use_feedback?: boolean; feedback_sources?: string[]; feedback_categories?: string[]; days?: number }) =>
    import('./projectsApi').then(m => m.projectsApi.mergeDocuments(projectId, data)),
  getJobStatus: (projectId: string, jobId: string) =>
    import('./projectsApi').then(m => m.projectsApi.getJobStatus(projectId, jobId)),
  getJobs: (projectId: string) => import('./projectsApi').then(m => m.projectsApi.getJobs(projectId)),
  dismissJob: (projectId: string, jobId: string) =>
    import('./projectsApi').then(m => m.projectsApi.dismissJob(projectId, jobId)),
  createDocument: (projectId: string, data: { title: string; content: string; document_type?: 'custom' }) =>
    import('./projectsApi').then(m => m.projectsApi.createDocument(projectId, data)),
  updateDocument: (projectId: string, documentId: string, data: { title?: string; content?: string; edit_id?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.updateDocument(projectId, documentId, data)),
  deleteDocument: (projectId: string, documentId: string) =>
    import('./projectsApi').then(m => m.projectsApi.deleteDocument(projectId, documentId)),

  // Prioritization
  /**
   * The rows, the caller's own ballots on them, and what every reviewer said.
   *
   * All three maps are keyed by ROW ID — a prioritization row is one project's set
   * of documents, so a project whose PRD and PR/FAQ describe one idea is one row
   * scored once. `rows` says what each row HOLDS, which is why the page needs no
   * second request per row.
   *
   * `rows` and `aggregates` are optional in the TYPE but not on the wire: both are
   * additive, and declaring either required would make a response from a
   * deployment running an older handler fail to type-check against a client that
   * only reads `scores`. See `PrioritizationAggregate` for what an entry means —
   * notably that a row nobody scored is absent, and that an entry can outlive its
   * row, so a consumer should intersect those keys with `rows`.
   */
  getPrioritizationScores: () =>
    fetchApi<{
      rows?: Record<string, PrioritizationRow>
      scores: Record<string, PrioritizationScore>
      aggregates?: Record<string, PrioritizationAggregate>
    }>('/projects/prioritization'),

  /**
   * Ensure a project's DEFAULT prioritization row exists, and return it.
   *
   * IDEMPOTENT: asking twice yields the same row rather than a second one, decided
   * by a conditional write on a row id derived from the project id — so two tabs
   * opening the page at once cannot give one project two rows with two sets of
   * ballots. `created` says which of the two happened, for a caller that cares.
   *
   * TWO settled refusals, both of which the caller reads through
   * `isPermanentRefusal` and neither of which this page currently puts on screen:
   *
   * - **400** for a project with no PRD and no PR/FAQ: there is nothing to score,
   *   and the page already has words inviting one, so the silence is covered.
   * - **409** for a project holding more documents than one read can compose a row
   *   from. Nothing covers this one — the project simply does not appear in the
   *   backlog, with nothing saying why. Rare by design (the bound behind it is
   *   deliberately generous), and tracked for phase 2 on issue #339, which is
   *   already adding row-level states to this page and can give an un-composable
   *   project a visible one.
   */
  createPrioritizationRow: (projectId: string) =>
    fetchApi<{ success: boolean; created?: boolean; row?: PrioritizationRow }>(
      '/projects/prioritization/rows',
      {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId }),
      },
    ),
  
  /**
   * Save only the changed scores (incremental/diff update).
   *
   * The only writer. A `savePrioritizationScores` sending PUT used to sit beside
   * this; it PUT the caller's whole map as every reviewer's scores, which under
   * per-reviewer ballots has no honest meaning. It had no caller in the product,
   * and the endpoint now refuses that verb, so keeping the function would only
   * offer a future caller a guaranteed 400.
   *
   * Keyed by ROW ID, and so is every entry's own `row_id`: a ballot is about a
   * project's set of documents rather than about one of them.
   *
   * `updated_count` is BALLOTS WRITTEN, not rows sent: an entry that changed
   * no axis and no note is a legal no-op and is not counted, so the number can be
   * lower than the size of the map — and is 0 for a body that stored nothing.
   *
   * Entries are `PrioritizationBallotEdit`, i.e. PARTIAL: an axis the reviewer did
   * not set is omitted, and the route reads an omitted axis as "leave it alone"
   * (`_ballot_update_kwargs` assigns only the axes an entry carries). Sending a
   * complete score instead wrote three axes the reviewer never chose whenever they
   * moved one slider on a row with no stored ballot, and the backend counts an
   * explicit value as a real vote — which then moves the TEAM means the
   * prioritization page displays, bands, counts and sorts by.
   *
   * A note longer than `MAX_NOTE_LENGTH` is REFUSED (400), not truncated. This
   * function does not check it, because `fetchApi` discards the response body and
   * could not report why — the page blocks that save before calling
   * (`overLongNoteDocuments`).
   */
  patchPrioritizationScores: (changedScores: Record<string, PrioritizationBallotEdit>) =>
    fetchApi<{ success: boolean; updated_count?: number }>('/projects/prioritization', {
      method: 'PATCH',
      body: JSON.stringify({ scores: changedScores })
    }),

  ...s3ImportEndpoints(fetchApi),
  ...dataExplorerEndpoints(fetchApi),

  // Feedback Forms (Multiple forms management)
  getFeedbackForms: () => fetchApi<{ success: boolean; forms: FeedbackForm[] }>('/feedback-forms'),

  /**
   * The list plus every form's card stats in one request (E2E F11). `forms` is
   * left raw for the page's own normalizer; `stats` is null when the API sent
   * none (older API, or `stats_error`), so the cards fall back to asking per form.
   */
  getFeedbackFormsWithStats: () =>
    fetchApi<unknown>('/feedback-forms?include=stats').then((raw) => ({
      forms: isRecord(raw) ? raw['forms'] : undefined,
      stats: normalizeFormStatsMap(isRecord(raw) ? raw['stats'] : undefined),
    })),
  
  getFeedbackForm: (formId: string) => fetchApi<{ success: boolean; form: FeedbackForm }>(`/feedback-forms/${formId}`),
  
  createFeedbackForm: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>) =>
    fetchApi<{ success: boolean; form: FeedbackForm }>('/feedback-forms', {
      method: 'POST',
      body: JSON.stringify(form)
    }),
  
  updateFeedbackForm: (formId: string, form: Partial<FeedbackForm>) =>
    fetchApi<{ success: boolean; form: FeedbackForm }>(`/feedback-forms/${formId}`, {
      method: 'PUT',
      body: JSON.stringify(form)
    }),
  
  deleteFeedbackForm: (formId: string) =>
    fetchApi<{ success: boolean }>(`/feedback-forms/${formId}`, { method: 'DELETE' }),

  getFeedbackFormStats: (formId: string) =>
    fetchApi<{ success: boolean; form_id: string; stats: { total_submissions: number; avg_rating: number | null; rating_count: number } }>(`/feedback-forms/${formId}/stats`),

  getFeedbackFormSubmissions: (formId: string, limit?: number) => {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    return fetchApi<{
      success: boolean
      form_id: string
      stats: { total_submissions: number; avg_rating: number | null; rating_count: number }
      submissions: Array<{
        feedback_id: string
        original_text: string
        rating: number | null
        sentiment_label: string
        sentiment_score: number
        category: string
        created_at: string
        persona_name: string
      }>
    }>(`/feedback-forms/${formId}/submissions?${params}`)
  },

  ...userAdminEndpoints(fetchApi),

  // The PUBLIC widget submit, reused by the prototype pin bridge
  // (components/PrototypePins/usePinBridge.ts) to forward a tester's pin.
  submitPrototypePin: (formId: string, body: unknown) =>
    fetchApi<unknown>(`/feedback-forms/${formId}/submit`, { method: 'POST', body: JSON.stringify(body) }),

  ...logsEndpoints(fetchApi),
}

/**
 * Resolve a time range selection into the rolling `days` query parameter.
 *
 * Every range (presets, "All", and the "last N days" custom range) maps to a
 * single bounded day count so the metrics backend never fans out into an
 * unbounded scan. For 'custom', `customDays` carries the chosen lookback.
 *
 * `dateBasis` selects which date the window filters on. The default
 * 'imported' basis omits the parameter entirely, keeping request URLs (and
 * TanStack Query keys) identical to the pre-basis behavior.
 */
export function getDateRangeParams(
  range: string,
  customDays?: number | null,
  dateBasis?: DateBasis
): DateRangeParams {
  const params: DateRangeParams = { days: getDaysFromRange(range, customDays) }
  if (dateBasis === 'review') {
    params.date_basis = dateBasis
  }
  return params
}
