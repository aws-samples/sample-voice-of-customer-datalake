/**
 * @fileoverview Core API client with auth-aware fetch, Zod validation,
 * and the `api` object for metrics, feedback, settings, integrations,
 * users, logs, and prioritization endpoints.
 *
 * Domain-specific APIs live in their own modules and should be imported
 * directly by consumers:
 *   import { projectsApi } from '../api/projectsApi'
 *   import { scrapersApi } from '../api/scrapersApi'
 *   import { feedbackFormsApi } from '../api/feedbackFormsApi'
 *   import { dataExplorerApi } from '../api/dataExplorerApi'
 */
import { z } from 'zod'
import {
  ApiError, AuthError,
} from '../lib/errors'
import { authService } from '../services/auth'
import {
  getBaseUrl, getAuthHeaders,
} from './baseUrl'
import { logsApi } from './logsApi'
import {
  MetricsSummarySchema, FeedbackItemSchema,
} from './schemas'
import type {
  FeedbackItem,
  MetricsSummary,
  SentimentBreakdown,
  CategoryBreakdown,
  SourceBreakdown,
  IntegrationStatus,
  EntitiesResponse,
  PrioritizationScore,
  ResolvedProblem,
} from './types'

// ── Internal helpers ────────────────────────────────────────────────────────

function buildHeaders(existingHeaders?: HeadersInit): Record<string, string> {
  const extra = existingHeaders ? Object.fromEntries(Object.entries(existingHeaders)) : undefined
  return getAuthHeaders(extra)
}

/**
 * Parse a JSON response with optional Zod schema validation.
 *
 * When a schema is provided, the response is validated at runtime — use this
 * for critical endpoints (metrics summary, feedback lists).
 *
 * When no schema is provided, the response is trusted as-is ("trust the server"
 * pattern). This is acceptable for less critical or rapidly-evolving endpoints
 * where maintaining a schema would add friction without meaningful safety.
 */
async function parseJsonResponse<T>(response: Response, schema?: z.ZodType<T>): Promise<T> {
  const rawJson: unknown = await response.json()
  if (schema) {
    return schema.parse(rawJson)
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentional cast for schema-less endpoints
  return rawJson as T
}

interface RetryOptions<T> {
  endpoint: string
  options: RequestInit | undefined
  headers: Record<string, string>
  baseUrl: string
  schema?: z.ZodType<T>
}

async function handleUnauthorized<T>({
  endpoint,
  options,
  headers,
  baseUrl,
  schema,
}: RetryOptions<T>): Promise<T> {
  await authService.refreshSession()
  const newIdToken = authService.getIdToken()
  if (newIdToken != null && newIdToken !== '') {
    headers['Authorization'] = newIdToken
  }
  const retryResponse = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers,
  })
  if (!retryResponse.ok) {
    throw new ApiError(retryResponse.status)
  }
  return await parseJsonResponse<T>(retryResponse, schema)
}

// ── Public utilities ────────────────────────────────────────────────────────

export async function fetchApi<T>(endpoint: string, options?: RequestInit, schema?: z.ZodType<T>): Promise<T> {
  const baseUrl = getBaseUrl()
  const headers = buildHeaders(options?.headers)

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers,
  })

  if (response.ok) {
    return await parseJsonResponse<T>(response, schema)
  }

  if (response.status === 401) {
    try {
      return await handleUnauthorized<T>({
        endpoint,
        options,
        headers,
        baseUrl,
        schema,
      })
    } catch {
      authService.signOut()
      window.location.href = '/login'
      throw new AuthError()
    }
  }

  throw new ApiError(response.status)
}

/** Build URLSearchParams from an object, filtering out undefined/null values. */
export function buildSearchParams(params: Record<string, string | number | boolean | undefined | null>): URLSearchParams {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      searchParams.set(key, String(value))
    }
  }
  return searchParams
}

// ── API object ──────────────────────────────────────────────────────────────
// Contains metrics, feedback, settings, integrations, users, logs,
// and prioritization endpoints.
//
// For other domains, import directly:
//   import { projectsApi } from '../api/projectsApi'
//   import { scrapersApi } from '../api/scrapersApi'
//   import { feedbackFormsApi } from '../api/feedbackFormsApi'
//   import { dataExplorerApi } from '../api/dataExplorerApi'

export const api = {
  // ── Feedback ────────────────────────────────────────────────────────────
  getFeedback: (params: {
    days?: number;
    source?: string;
    category?: string;
    sentiment?: string;
    limit?: number
  }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<{
      count: number;
      items: FeedbackItem[]
    }>(
      `/feedback?${searchParams}`,
      undefined,
      z.object({
        count: z.coerce.number(),
        items: z.array(FeedbackItemSchema),
      }),
    )
  },

  getFeedbackById: (id: string) => fetchApi<FeedbackItem>(`/feedback/${id}`),

  getUrgentFeedback: (params: {
    days?: number;
    limit?: number;
    source?: string;
    sentiment?: string;
    category?: string
  }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<{
      count: number;
      items: FeedbackItem[]
    }>(`/feedback/urgent?${searchParams}`)
  },

  searchFeedback: (params: {
    q: string;
    days?: number;
    limit?: number;
    source?: string;
    sentiment?: string;
    category?: string
  }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<{
      count: number;
      items: FeedbackItem[];
      entities: EntitiesResponse['entities'];
      query: string
    }>(`/feedback/search?${searchParams}`)
  },

  getSimilarFeedback: (id: string, limit?: number) => {
    const searchParams = new URLSearchParams()
    if (limit != null) searchParams.set('limit', String(limit))
    return fetchApi<{
      source_feedback_id: string;
      count: number;
      items: FeedbackItem[]
    }>(`/feedback/${id}/similar?${searchParams}`)
  },

  getEntities: (params: {
    days?: number;
    limit?: number;
    source?: string
  }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<EntitiesResponse>(`/feedback/entities?${searchParams}`)
  },

  // ── Problem Resolution ──────────────────────────────────────────────────
  getResolvedProblems: () =>
    fetchApi<{ resolved: ResolvedProblem[] }>('/feedback/problems/resolved'),

  resolveProblem: (problemId: string, data: {
    category: string;
    subcategory: string;
    problem_text: string
  }) =>
    fetchApi<{
      success: boolean;
      problem_id: string;
      resolved_at: string
    }>(`/feedback/problems/${problemId}/resolve`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  unresolveProblem: (problemId: string) =>
    fetchApi<{
      success: boolean;
      problem_id: string
    }>(`/feedback/problems/${problemId}/resolve`, { method: 'DELETE' }),

  // ── Metrics ─────────────────────────────────────────────────────────────
  getSummary: (days: number, source?: string) => {
    const params = buildSearchParams({
      days,
      source,
    })
    return fetchApi<MetricsSummary>(`/metrics/summary?${params}`, undefined, MetricsSummarySchema)
  },
  getSentiment: (days: number, source?: string) => {
    const params = buildSearchParams({
      days,
      source,
    })
    return fetchApi<SentimentBreakdown>(`/metrics/sentiment?${params}`)
  },
  getCategories: (days: number, source?: string) => {
    const params = buildSearchParams({
      days,
      source,
    })
    return fetchApi<CategoryBreakdown>(`/metrics/categories?${params}`)
  },
  getSources: (days: number) => fetchApi<SourceBreakdown>(`/metrics/sources?${buildSearchParams({ days })}`),
  getPersonas: (days: number, source?: string) => {
    const params = buildSearchParams({
      days,
      source,
    })
    return fetchApi<{
      period_days: number;
      personas: Record<string, number>
    }>(`/metrics/personas?${params}`)
  },

  // ── Data Source Schedules ───────────────────────────────────────────────
  getSourcesStatus: (sources?: string[]) => {
    const params = sources?.length == null ? '' : `?sources=${sources.join(',')}`
    return fetchApi<{
      sources: Record<string, {
        enabled: boolean;
        schedule?: string;
        rule_name?: string;
        exists?: boolean;
        error?: string
      }>
    }>(`/sources/status${params}`)
  },

  enableSource: (source: string) => fetchApi<{
    success: boolean;
    source: string;
    enabled: boolean;
    message?: string
  }>(`/sources/${source}/enable`, { method: 'PUT' }),

  disableSource: (source: string) => fetchApi<{
    success: boolean;
    source: string;
    enabled: boolean;
    message?: string
  }>(`/sources/${source}/disable`, { method: 'PUT' }),

  runSource: (source: string, appId?: string) => fetchApi<{
    success: boolean;
    message: string;
    source: string
  }>(`/sources/${source}/run`, {
    method: 'POST',
    ...(appId != null && appId !== '' ? { body: JSON.stringify({ app_id: appId }) } : {}),
  }),

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

  // ── Brand Settings ──────────────────────────────────────────────────────
  getBrandSettings: () => fetchApi<{
    brand_name: string;
    brand_handles: string[];
    hashtags: string[];
    urls_to_track: string[];
    error?: string
  }>('/settings/brand'),

  saveBrandSettings: (settings: {
    brand_name: string;
    brand_handles: string[];
    hashtags: string[];
    urls_to_track: string[]
  }) => fetchApi<{
    success: boolean;
    message: string;
    settings: typeof settings
  }>('/settings/brand', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),

  // ── Review Configuration ────────────────────────────────────────────────
  getReviewSettings: () => fetchApi<{ primary_language: string }>('/settings/review'),

  saveReviewSettings: (settings: { primary_language: string }) =>
    fetchApi<{
      success: boolean;
      message: string;
      settings: typeof settings
    }>('/settings/review', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  // ── Categories Configuration ────────────────────────────────────────────
  getCategoriesConfig: () => fetchApi<{
    categories: Array<{
      id: string;
      name: string;
      description?: string;
      subcategories: Array<{
        id: string;
        name: string;
        description?: string
      }>
    }>
    updated_at?: string
  }>('/settings/categories'),

  saveCategoriesConfig: (config: {
    categories: Array<{
      id: string;
      name: string;
      description?: string;
      subcategories: Array<{
        id: string;
        name: string;
        description?: string
      }>
    }>
  }) => fetchApi<{
    success: boolean;
    message: string
  }>('/settings/categories', {
    method: 'PUT',
    body: JSON.stringify(config),
  }),

  generateCategories: (companyDescription: string) =>
    fetchApi<{
      success: boolean
      categories: Array<{
        id: string;
        name: string;
        description?: string;
        subcategories: Array<{
          id: string;
          name: string;
          description?: string
        }>
      }>
    }>('/settings/categories/generate', {
      method: 'POST',
      body: JSON.stringify({ company_description: companyDescription }),
    }),

  // ── Integrations ────────────────────────────────────────────────────────
  getIntegrationStatus: () => fetchApi<IntegrationStatus>('/integrations/status'),

  updateIntegrationCredentials: (source: string, credentials: Record<string, string>) =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/integrations/${source}/credentials`, {
      method: 'PUT',
      body: JSON.stringify(credentials),
    }),

  getIntegrationCredentials: (source: string, keys: string[]) =>
    fetchApi<Record<string, string>>(`/integrations/${source}/credentials?keys=${keys.join(',')}`),

  testIntegration: (source: string) =>
    fetchApi<{
      success: boolean;
      message?: string;
      error?: string;
      details?: Record<string, unknown>
    }>(`/integrations/${source}/test`, { method: 'POST' }),

  // ── Prioritization ──────────────────────────────────────────────────────
  getPrioritizationScores: () =>
    fetchApi<{ scores: Record<string, PrioritizationScore> }>('/projects/prioritization'),

  savePrioritizationScores: (scores: Record<string, PrioritizationScore>) =>
    fetchApi<{ success: boolean }>('/projects/prioritization', {
      method: 'PUT',
      body: JSON.stringify({ scores }),
    }),

  patchPrioritizationScores: (changedScores: Record<string, PrioritizationScore>) =>
    fetchApi<{
      success: boolean;
      updated_count?: number
    }>('/projects/prioritization', {
      method: 'PATCH',
      body: JSON.stringify({ scores: changedScores }),
    }),

  // ── Users, Logs & API Tokens (extracted to logsApi.ts) ───────────────────
  ...logsApi,
}
