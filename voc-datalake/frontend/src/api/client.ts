import { useConfigStore } from '../store/configStore'
import { authService } from '../services/auth'
import type {
  FeedbackItem,
  MetricsSummary,
  SentimentBreakdown,
  CategoryBreakdown,
  SourceBreakdown,
  IntegrationStatus,
  ScraperConfig,
  EntitiesResponse,
  ProjectPersona,
  Project,
  PrioritizationScore,
  FeedbackFormConfig,
  FeedbackForm,
  CognitoUser,
  ValidationLogEntry,
  ProcessingLogEntry,
  ScraperLogEntry,
  LogsSummary,
  ResolvedProblem,
  ApiToken,
  CreateApiTokenResponse,
} from './types'

// Re-export all types for backward compatibility
export type {
  FeedbackItem,
  MetricsSummary,
  SentimentBreakdown,
  CategoryBreakdown,
  SourceBreakdown,
  IntegrationStatus,
  ScraperConfig,
  ScraperTemplate,
  EntitiesResponse,
  ProjectPersona,
  Project,
  PrioritizationScore,
  S3ImportSource,
  S3ImportFile,
  FeedbackFormConfig,
  FeedbackForm,
  CognitoUser,
  ValidationLogEntry,
  ProcessingLogEntry,
  ScraperLogEntry,
  LogsSummary,
  ResolvedProblem,
  ApiToken,
  CreateApiTokenResponse,
} from './types'
export type { ProjectJob, ProjectDocument, ProjectDetail } from './types'

const getBaseUrl = () => {
  const { config } = useConfigStore.getState()
  return config.apiEndpoint || '/api'
}

export function stripTrailingSlashes(url: string): string {
  // Remove trailing slashes without regex backtracking
  const trimmed = url.trimEnd()
  const lastNonSlash = trimmed.length - [...trimmed].reverse().findIndex(c => c !== '/')
  return trimmed.slice(0, lastNonSlash)
}

function buildHeaders(existingHeaders?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(existingHeaders ? Object.fromEntries(Object.entries(existingHeaders)) : {}),
  }
  
  if (authService.isConfigured()) {
    const idToken = authService.getIdToken()
    if (idToken) {
      headers['Authorization'] = idToken
    }
  }
  
  return headers
}

import { z } from 'zod'
import { MetricsSummarySchema, FeedbackItemSchema } from './schemas'

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
  // Trust the server — no runtime validation for endpoints without a schema
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentional cast for schema-less endpoints
  return rawJson as T
}

async function handleUnauthorized<T>(
  endpoint: string,
  options: RequestInit | undefined,
  headers: Record<string, string>,
  baseUrl: string,
  schema?: z.ZodType<T>
): Promise<T> {
  await authService.refreshSession()
  const newIdToken = authService.getIdToken()
  if (newIdToken) {
    headers['Authorization'] = newIdToken
  }
  const retryResponse = await fetch(`${baseUrl}${endpoint}`, { ...options, headers })
  if (!retryResponse.ok) {
    throw new Error(`API Error: ${retryResponse.status}`)
  }
  return parseJsonResponse<T>(retryResponse, schema)
}

export async function fetchApi<T>(endpoint: string, options?: RequestInit, schema?: z.ZodType<T>): Promise<T> {
  const baseUrl = stripTrailingSlashes(getBaseUrl())
  const headers = buildHeaders(options?.headers)
  
  const response = await fetch(`${baseUrl}${endpoint}`, { ...options, headers })
  
  if (response.ok) {
    return parseJsonResponse<T>(response, schema)
  }
  
  if (response.status === 401) {
    try {
      return await handleUnauthorized<T>(endpoint, options, headers, baseUrl, schema)
    } catch {
      authService.signOut()
      window.location.href = '/login'
      throw new Error('Session expired. Please login again.')
    }
  }
  
  throw new Error(`API Error: ${response.status}`)
}

// Helper to build URLSearchParams from an object, filtering out undefined/null values
export function buildSearchParams(params: Record<string, string | number | boolean | undefined | null>): URLSearchParams {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      searchParams.set(key, String(value))
    }
  }
  return searchParams
}

export const api = {
  // Feedback
  getFeedback: (params: { days?: number; source?: string; category?: string; sentiment?: string; limit?: number }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<{ count: number; items: FeedbackItem[] }>(
      `/feedback?${searchParams}`,
      undefined,
      z.object({ count: z.coerce.number(), items: z.array(FeedbackItemSchema) }),
    )
  },
  
  getFeedbackById: (id: string) => fetchApi<FeedbackItem>(`/feedback/${id}`),
  
  getUrgentFeedback: (params: { days?: number; limit?: number; source?: string; sentiment?: string; category?: string }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<{ count: number; items: FeedbackItem[] }>(`/feedback/urgent?${searchParams}`)
  },
  
  searchFeedback: (params: { q: string; days?: number; limit?: number; source?: string; sentiment?: string; category?: string }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<{ count: number; items: FeedbackItem[]; entities: EntitiesResponse['entities']; query: string }>(`/feedback/search?${searchParams}`)
  },
  
  getSimilarFeedback: (id: string, limit?: number) => {
    const searchParams = new URLSearchParams()
    if (limit) searchParams.set('limit', String(limit))
    return fetchApi<{ source_feedback_id: string; count: number; items: FeedbackItem[] }>(`/feedback/${id}/similar?${searchParams}`)
  },
  
  getEntities: (params: { days?: number; limit?: number; source?: string }) => {
    const searchParams = buildSearchParams(params)
    return fetchApi<EntitiesResponse>(`/feedback/entities?${searchParams}`)
  },

  // Problem Resolution
  getResolvedProblems: () =>
    fetchApi<{ resolved: ResolvedProblem[] }>('/feedback/problems/resolved'),

  resolveProblem: (problemId: string, data: { category: string; subcategory: string; problem_text: string }) =>
    fetchApi<{ success: boolean; problem_id: string; resolved_at: string }>(`/feedback/problems/${problemId}/resolve`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  unresolveProblem: (problemId: string) =>
    fetchApi<{ success: boolean; problem_id: string }>(`/feedback/problems/${problemId}/resolve`, {
      method: 'DELETE',
    }),
  
  // Metrics
  getSummary: (days: number, source?: string) => {
    const params = new URLSearchParams({ days: String(days) })
    if (source) params.set('source', source)
    return fetchApi<MetricsSummary>(`/metrics/summary?${params}`, undefined, MetricsSummarySchema)
  },
  getSentiment: (days: number, source?: string) => {
    const params = new URLSearchParams({ days: String(days) })
    if (source) params.set('source', source)
    return fetchApi<SentimentBreakdown>(`/metrics/sentiment?${params}`)
  },
  getCategories: (days: number, source?: string) => {
    const params = new URLSearchParams({ days: String(days) })
    if (source) params.set('source', source)
    return fetchApi<CategoryBreakdown>(`/metrics/categories?${params}`)
  },
  getSources: (days: number) => fetchApi<SourceBreakdown>(`/metrics/sources?days=${days}`),
  getPersonas: (days: number, source?: string) => {
    const params = new URLSearchParams({ days: String(days) })
    if (source) params.set('source', source)
    return fetchApi<{ period_days: number; personas: Record<string, number> }>(`/metrics/personas?${params}`)
  },
  
  // Data Source Schedules
  getSourcesStatus: (sources?: string[]) => {
    const params = sources?.length ? `?sources=${sources.join(',')}` : ''
    return fetchApi<{ sources: Record<string, { enabled: boolean; schedule?: string; rule_name?: string; exists?: boolean; error?: string }> }>(`/sources/status${params}`)
  },
  
  enableSource: (source: string) => fetchApi<{ success: boolean; source: string; enabled: boolean; message?: string }>(`/sources/${source}/enable`, { method: 'PUT' }),
  
  disableSource: (source: string) => fetchApi<{ success: boolean; source: string; enabled: boolean; message?: string }>(`/sources/${source}/disable`, { method: 'PUT' }),

  runSource: (source: string) => fetchApi<{ success: boolean; message: string; source: string }>(`/sources/${source}/run`, { method: 'POST' }),

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

  // Review Configuration
  getReviewSettings: () => fetchApi<{
    primary_language: string
  }>('/settings/review'),

  saveReviewSettings: (settings: {
    primary_language: string
  }) => fetchApi<{ success: boolean; message: string; settings: typeof settings }>('/settings/review', {
    method: 'PUT',
    body: JSON.stringify(settings)
  }),

  // Categories Configuration
  getCategoriesConfig: () => fetchApi<{ 
    categories: Array<{
      id: string
      name: string
      description?: string
      subcategories: Array<{ id: string; name: string; description?: string }>
    }>
    updated_at?: string 
  }>('/settings/categories'),
  
  saveCategoriesConfig: (config: { 
    categories: Array<{
      id: string
      name: string
      description?: string
      subcategories: Array<{ id: string; name: string; description?: string }>
    }> 
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

  // Scrapers - delegated to scrapersApi for code splitting
  getScrapers: () => import('./scrapersApi').then(m => m.scrapersApi.getScrapers()),
  getScraperTemplates: () => import('./scrapersApi').then(m => m.scrapersApi.getScraperTemplates()),
  saveScraper: (scraper: ScraperConfig) => import('./scrapersApi').then(m => m.scrapersApi.saveScraper(scraper)),
  deleteScraper: (id: string) => import('./scrapersApi').then(m => m.scrapersApi.deleteScraper(id)),
  analyzeUrlForSelectors: (url: string) => import('./scrapersApi').then(m => m.scrapersApi.analyzeUrlForSelectors(url)),
  runScraper: (id: string) => import('./scrapersApi').then(m => m.scrapersApi.runScraper(id)),
  getScraperStatus: (id: string) => import('./scrapersApi').then(m => m.scrapersApi.getScraperStatus(id)),
  getScraperRuns: (id: string) => import('./scrapersApi').then(m => m.scrapersApi.getScraperRuns(id)),

  // Manual Import - delegated to scrapersApi
  startManualImportParse: (sourceUrl: string, rawText: string) => import('./scrapersApi').then(m => m.scrapersApi.startManualImportParse(sourceUrl, rawText)),
  getManualImportStatus: (jobId: string) => import('./scrapersApi').then(m => m.scrapersApi.getManualImportStatus(jobId)),
  confirmManualImport: (jobId: string, reviews: Array<{ text: string; rating: number | null; author: string | null; date: string | null; title: string | null }>) => import('./scrapersApi').then(m => m.scrapersApi.confirmManualImport(jobId, reviews)),
  uploadJsonFeedback: (items: Array<Record<string, unknown>>) => import('./scrapersApi').then(m => m.scrapersApi.uploadJsonFeedback(items)),

  // Projects - delegated to projectsApi for file size reduction
  getProjects: () => import('./projectsApi').then(m => m.projectsApi.getProjects()),
  createProject: (data: { name: string; description?: string; filters?: Record<string, unknown> }) =>
    import('./projectsApi').then(m => m.projectsApi.createProject(data)),
  getProject: (id: string) => import('./projectsApi').then(m => m.projectsApi.getProject(id)),
  updateProject: (id: string, data: Partial<Project>) =>
    import('./projectsApi').then(m => m.projectsApi.updateProject(id, data)),
  deleteProject: (id: string) => import('./projectsApi').then(m => m.projectsApi.deleteProject(id)),
  generatePersonas: (projectId: string, filters?: { sources?: string[]; categories?: string[]; sentiments?: string[]; persona_count?: number; custom_instructions?: string; days?: number; response_language?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.generatePersonas(projectId, filters)),
  createPersona: (projectId: string, persona: Omit<ProjectPersona, 'persona_id' | 'created_at'>) =>
    import('./projectsApi').then(m => m.projectsApi.createPersona(projectId, persona)),
  updatePersona: (projectId: string, personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    import('./projectsApi').then(m => m.projectsApi.updatePersona(projectId, personaId, data)),
  deletePersona: (projectId: string, personaId: string) =>
    import('./projectsApi').then(m => m.projectsApi.deletePersona(projectId, personaId)),
  importPersona: (projectId: string, data: { input_type: 'pdf' | 'image' | 'text'; content: string; media_type?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.importPersona(projectId, data)),
  runResearch: (projectId: string, data: { question: string; title?: string; sources?: string[]; categories?: string[]; sentiments?: string[]; days?: number; selected_persona_ids?: string[]; selected_document_ids?: string[]; response_language?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.runResearch(projectId, data)),
  generateDocument: (projectId: string, data: { doc_type: 'prd' | 'prfaq'; title: string; feature_idea: string; data_sources: { feedback: boolean; personas: boolean; documents: boolean; research: boolean }; selected_persona_ids: string[]; selected_document_ids: string[]; feedback_sources: string[]; feedback_categories: string[]; days: number; customer_questions?: string[]; response_language?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.generateDocument(projectId, data)),
  mergeDocuments: (projectId: string, data: { output_type: 'prd' | 'prfaq' | 'custom'; title: string; instructions: string; selected_document_ids: string[]; selected_persona_ids?: string[]; use_feedback?: boolean; feedback_sources?: string[]; feedback_categories?: string[]; days?: number; response_language?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.mergeDocuments(projectId, data)),
  getJobStatus: (projectId: string, jobId: string) =>
    import('./projectsApi').then(m => m.projectsApi.getJobStatus(projectId, jobId)),
  getJobs: (projectId: string) => import('./projectsApi').then(m => m.projectsApi.getJobs(projectId)),
  dismissJob: (projectId: string, jobId: string) =>
    import('./projectsApi').then(m => m.projectsApi.dismissJob(projectId, jobId)),
  createDocument: (projectId: string, data: { title: string; content: string; document_type?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.createDocument(projectId, data)),
  updateDocument: (projectId: string, documentId: string, data: { title?: string; content?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.updateDocument(projectId, documentId, data)),
  deleteDocument: (projectId: string, documentId: string) =>
    import('./projectsApi').then(m => m.projectsApi.deleteDocument(projectId, documentId)),

  // Prioritization
  getPrioritizationScores: () => 
    fetchApi<{ scores: Record<string, PrioritizationScore> }>('/projects/prioritization'),
  
  savePrioritizationScores: (scores: Record<string, PrioritizationScore>) =>
    fetchApi<{ success: boolean }>('/projects/prioritization', {
      method: 'PUT',
      body: JSON.stringify({ scores })
    }),

  /** Save only the changed scores (incremental/diff update) */
  patchPrioritizationScores: (changedScores: Record<string, PrioritizationScore>) =>
    fetchApi<{ success: boolean; updated_count?: number }>('/projects/prioritization', {
      method: 'PATCH',
      body: JSON.stringify({ scores: changedScores })
    }),

  // S3 Import - delegated to dataExplorerApi for code splitting
  getS3ImportSources: () => import('./dataExplorerApi').then(m => m.dataExplorerApi.getS3ImportSources()),
  createS3ImportSource: (name: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.createS3ImportSource(name)),
  getS3ImportFiles: (params?: { source?: string; include_processed?: boolean }) => import('./dataExplorerApi').then(m => m.dataExplorerApi.getS3ImportFiles(params)),
  getS3UploadUrl: (filename: string, source: string, contentType?: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.getS3UploadUrl(filename, source, contentType)),
  deleteS3ImportFile: (key: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.deleteS3ImportFile(key)),

  // Data Explorer - delegated to dataExplorerApi for code splitting
  getDataExplorerBuckets: () => import('./dataExplorerApi').then(m => m.dataExplorerApi.getDataExplorerBuckets()),
  getDataExplorerS3: (prefix?: string, bucket?: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.getDataExplorerS3(prefix, bucket)),
  getDataExplorerS3Preview: (key: string, bucket?: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.getDataExplorerS3Preview(key, bucket)),
  saveDataExplorerS3: (key: string, content: string, syncToDynamo?: boolean, bucket?: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.saveDataExplorerS3(key, content, syncToDynamo, bucket)),
  deleteDataExplorerS3: (key: string, bucket?: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.deleteDataExplorerS3(key, bucket)),
  saveDataExplorerFeedback: (feedbackId: string, data: Partial<FeedbackItem>, syncToS3?: boolean) => import('./dataExplorerApi').then(m => m.dataExplorerApi.saveDataExplorerFeedback(feedbackId, data, syncToS3)),
  deleteDataExplorerFeedback: (feedbackId: string) => import('./dataExplorerApi').then(m => m.dataExplorerApi.deleteDataExplorerFeedback(feedbackId)),

  // Feedback Forms - delegated to feedbackFormsApi for code splitting
  getFeedbackFormConfig: () => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.getFeedbackFormConfig()),
  saveFeedbackFormConfig: (config: FeedbackFormConfig) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.saveFeedbackFormConfig(config)),
  submitFeedbackForm: (data: { text: string; rating?: number; email?: string; name?: string; page_url?: string; custom_fields?: Record<string, string> }) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.submitFeedbackForm(data)),
  getFeedbackFormEmbed: (apiEndpoint: string) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.getFeedbackFormEmbed(apiEndpoint)),
  getFeedbackForms: () => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.getFeedbackForms()),
  getFeedbackForm: (formId: string) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.getFeedbackForm(formId)),
  createFeedbackForm: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.createFeedbackForm(form)),
  updateFeedbackForm: (formId: string, form: Partial<FeedbackForm>) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.updateFeedbackForm(formId, form)),
  deleteFeedbackForm: (formId: string) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.deleteFeedbackForm(formId)),
  getFeedbackFormStats: (formId: string) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.getFeedbackFormStats(formId)),
  getFeedbackFormSubmissions: (formId: string, limit?: number) => import('./feedbackFormsApi').then(m => m.feedbackFormsApi.getFeedbackFormSubmissions(formId, limit)),

  // User Administration (admin only)
  getUsers: () => fetchApi<{ success: boolean; users: CognitoUser[]; message?: string }>('/users'),
  
  createUser: (data: { username: string; email: string; name?: string; group: 'admins' | 'users' }) =>
    fetchApi<{ success: boolean; message?: string; error?: string; user?: CognitoUser }>('/users', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  updateUserGroup: (username: string, group: 'admins' | 'users') =>
    fetchApi<{ success: boolean; message: string }>(`/users/${encodeURIComponent(username)}/group`, {
      method: 'PUT',
      body: JSON.stringify({ group })
    }),
  
  resetUserPassword: (username: string) =>
    fetchApi<{ success: boolean; message: string }>(`/users/${encodeURIComponent(username)}/reset-password`, {
      method: 'POST'
    }),
  
  enableUser: (username: string) =>
    fetchApi<{ success: boolean; message: string }>(`/users/${encodeURIComponent(username)}/enable`, {
      method: 'PUT'
    }),
  
  disableUser: (username: string) =>
    fetchApi<{ success: boolean; message: string }>(`/users/${encodeURIComponent(username)}/disable`, {
      method: 'PUT'
    }),
  
  deleteUser: (username: string) =>
    fetchApi<{ success: boolean; message: string }>(`/users/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    }),

  // Logs API
  getValidationLogs: (params?: { source?: string; days?: number; limit?: number }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{ logs: ValidationLogEntry[]; count: number; days: number }>(`/logs/validation?${searchParams}`)
  },

  getProcessingLogs: (params?: { source?: string; days?: number; limit?: number }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{ logs: ProcessingLogEntry[]; count: number; days: number }>(`/logs/processing?${searchParams}`)
  },

  getScraperLogs: (scraperId: string, params?: { days?: number; limit?: number }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{ scraper_id: string; logs: ScraperLogEntry[]; count: number }>(`/logs/scraper/${scraperId}?${searchParams}`)
  },

  getLogsSummary: (days?: number) => {
    const searchParams = buildSearchParams({ days })
    return fetchApi<{ summary: LogsSummary; days: number }>(`/logs/summary?${searchParams}`)
  },

  clearValidationLogs: (source: string) =>
    fetchApi<{ success: boolean; deleted: number }>(`/logs/validation/${source}`, {
      method: 'DELETE'
    }),

  // API Tokens
  createApiToken: (projectId: string, data: { name: string; scope: 'read' | 'read-write' }) =>
    fetchApi<CreateApiTokenResponse>(`/projects/${projectId}/api-tokens`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  listApiTokens: (projectId: string) =>
    fetchApi<{ success: boolean; tokens: ApiToken[] }>(`/projects/${projectId}/api-tokens`),

  deleteApiToken: (projectId: string, tokenId: string) =>
    fetchApi<{ success: boolean; message: string }>(`/projects/${projectId}/api-tokens/${tokenId}`, {
      method: 'DELETE',
    }),
}

export function getDaysFromRange(range: string, customRange?: { start: string; end: string } | null): number {
  if (range === 'custom' && customRange) {
    const start = new Date(customRange.start)
    const end = new Date(customRange.end)
    const diffTime = Math.abs(end.getTime() - start.getTime())
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
  }
  
  switch (range) {
    case '24h': return 1
    case '48h': return 2
    case '7d': return 7
    case '30d': return 30
    default: return 7
  }
}

