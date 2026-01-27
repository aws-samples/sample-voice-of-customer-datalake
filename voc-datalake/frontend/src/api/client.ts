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
} from './types'
export type { ProjectJob, ProjectDocument, ProjectDetail, ChatMessage, ChatConversation } from './types'

const getBaseUrl = () => {
  const { config } = useConfigStore.getState()
  return config.apiEndpoint || '/api'
}

const streamUrlCache: { value: string | null } = { value: null }

function stripTrailingSlashes(url: string): string {
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

async function handleUnauthorized<T>(
  endpoint: string,
  options: RequestInit | undefined,
  headers: Record<string, string>,
  baseUrl: string
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
  return parseJsonResponse<T>(retryResponse)
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseUrl = stripTrailingSlashes(getBaseUrl())
  const headers = buildHeaders(options?.headers)
  
  const response = await fetch(`${baseUrl}${endpoint}`, { ...options, headers })
  
  if (response.ok) {
    return parseJsonResponse<T>(response)
  }
  
  if (response.status === 401) {
    try {
      return await handleUnauthorized<T>(endpoint, options, headers, baseUrl)
    } catch {
      authService.signOut()
      window.location.href = '/login'
      throw new Error('Session expired. Please login again.')
    }
  }
  
  throw new Error(`API Error: ${response.status}`)
}

async function getStreamUrl(): Promise<string> {
  if (streamUrlCache.value !== null) return streamUrlCache.value
  
  try {
    const config = await fetchApi<{ chat_stream_url: string }>('/projects/config')
    streamUrlCache.value = config.chat_stream_url || ''
    return streamUrlCache.value
  } catch {
    streamUrlCache.value = ''
    return ''
  }
}

// Helper to build URLSearchParams from an object, filtering out undefined/null values
function buildSearchParams(params: Record<string, string | number | boolean | undefined | null>): URLSearchParams {
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
    return fetchApi<{ count: number; items: FeedbackItem[] }>(`/feedback?${searchParams}`)
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
  
  // Metrics
  getSummary: (days: number, source?: string) => {
    const params = new URLSearchParams({ days: String(days) })
    if (source) params.set('source', source)
    return fetchApi<MetricsSummary>(`/metrics/summary?${params}`)
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
  
  // Chat
  chat: (message: string, context?: string) => fetchApi<{ response: string; sources?: FeedbackItem[] }>('/chat', {
    method: 'POST',
    body: JSON.stringify({ message, context })
  }),

  // Chat with streaming (uses Lambda Function URL to bypass API Gateway timeout)
  chatStream: async (message: string, context?: string, days?: number): Promise<{ response: string; sources?: FeedbackItem[]; metadata?: { total_feedback: number; days_analyzed: number; urgent_count: number } }> => {
    const streamEndpoint = await getStreamUrl()
    if (!streamEndpoint) return api.chat(message, context)
    const { streamApi } = await import('./streamApi')
    return streamApi.chatStream(streamEndpoint, message, context, days)
  },

  // Data Source Schedules
  getSourcesStatus: () => fetchApi<{ sources: Record<string, { enabled: boolean; schedule?: string; rule_name?: string; exists?: boolean; error?: string }> }>('/sources/status'),
  
  enableSource: (source: string) => fetchApi<{ success: boolean; source: string; enabled: boolean; message?: string }>(`/sources/${source}/enable`, { method: 'PUT' }),
  
  disableSource: (source: string) => fetchApi<{ success: boolean; source: string; enabled: boolean; message?: string }>(`/sources/${source}/disable`, { method: 'PUT' }),

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
  
  testIntegration: (source: string) => 
    fetchApi<{ success: boolean; message: string; details?: Record<string, unknown> }>(`/integrations/${source}/test`, {
      method: 'POST'
    }),

  // Scrapers
  getScrapers: () => fetchApi<{ scrapers: ScraperConfig[] }>('/scrapers'),
  
  getScraperTemplates: () => fetchApi<{ templates: ScraperTemplate[] }>('/scrapers/templates'),
  
  saveScraper: (scraper: ScraperConfig) =>
    fetchApi<{ success: boolean; scraper: ScraperConfig }>('/scrapers', {
      method: 'POST',
      body: JSON.stringify({ scraper })
    }),
  
  deleteScraper: (id: string) =>
    fetchApi<{ success: boolean }>(`/scrapers/${id}`, { method: 'DELETE' }),
  
  analyzeUrlForSelectors: (url: string) =>
    fetchApi<{ 
      success: boolean
      selectors?: {
        container_selector: string
        text_selector: string
        rating_selector?: string
        rating_attribute?: string
        author_selector?: string
        date_selector?: string
        title_selector?: string
        confidence: string
        detected_reviews_count: number
        notes?: string
        warnings?: string[]
      }
      message?: string 
    }>('/scrapers/analyze-url', {
      method: 'POST',
      body: JSON.stringify({ url })
    }),
  
  runScraper: (id: string) =>
    fetchApi<{ success: boolean; execution_id: string; status: string }>(`/scrapers/${id}/run`, { method: 'POST' }),
  
  getScraperStatus: (id: string) =>
    fetchApi<{
      scraper_id: string
      execution_id?: string
      status: string
      started_at?: string
      completed_at?: string
      pages_scraped: number
      items_found: number
      errors: string[]
    }>(`/scrapers/${id}/status`),
  
  getScraperRuns: (id: string) =>
    fetchApi<{ runs: Array<{ sk: string; status: string; started_at: string; completed_at?: string; pages_scraped: number; items_found: number }> }>(`/scrapers/${id}/runs`),

  // Manual Import
  startManualImportParse: (sourceUrl: string, rawText: string) =>
    fetchApi<{ success: boolean; job_id: string; source_origin?: string; message?: string }>('/scrapers/manual/parse', {
      method: 'POST',
      body: JSON.stringify({ source_url: sourceUrl, raw_text: rawText })
    }),

  getManualImportStatus: (jobId: string) =>
    fetchApi<{
      status: 'processing' | 'completed' | 'failed' | 'not_found'
      source_origin?: string
      source_url?: string
      reviews?: Array<{ text: string; rating: number | null; author: string | null; date: string | null; title: string | null }>
      unparsed_sections?: string[]
      error?: string
    }>(`/scrapers/manual/parse/${jobId}`),

  confirmManualImport: (jobId: string, reviews: Array<{ text: string; rating: number | null; author: string | null; date: string | null; title: string | null }>) =>
    fetchApi<{ success: boolean; imported_count?: number; s3_uri?: string; message?: string; errors?: string[] }>('/scrapers/manual/confirm', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, reviews })
    }),

  // Projects - delegated to projectsApi for file size reduction
  getProjects: () => import('./projectsApi').then(m => m.projectsApi.getProjects()),
  createProject: (data: { name: string; description?: string; filters?: Record<string, unknown> }) =>
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
  importPersona: (projectId: string, data: { input_type: 'pdf' | 'image' | 'text'; content: string; media_type?: string }) =>
    import('./projectsApi').then(m => m.projectsApi.importPersona(projectId, data)),
  projectChat: (projectId: string, message: string, selectedPersonas?: string[], selectedDocuments?: string[]) =>
    import('./projectsApi').then(m => m.projectsApi.projectChat(projectId, message, selectedPersonas, selectedDocuments)),
  projectChatStream: async (projectId: string, message: string, selectedPersonas?: string[], selectedDocuments?: string[]) => {
    const streamEndpoint = await getStreamUrl()
    if (!streamEndpoint) return api.projectChat(projectId, message, selectedPersonas, selectedDocuments)
    const { streamApi } = await import('./streamApi')
    return streamApi.projectChatStream(streamEndpoint, projectId, message, selectedPersonas, selectedDocuments)
  },
  runResearch: (projectId: string, data: { question: string; title?: string; sources?: string[]; categories?: string[]; sentiments?: string[]; days?: number; selected_persona_ids?: string[]; selected_document_ids?: string[] }) =>
    import('./projectsApi').then(m => m.projectsApi.runResearch(projectId, data)),
  generateDocument: (projectId: string, data: { doc_type: 'prd' | 'prfaq'; title: string; feature_idea: string; data_sources: { feedback: boolean; personas: boolean; documents: boolean; research: boolean }; selected_persona_ids: string[]; selected_document_ids: string[]; feedback_sources: string[]; feedback_categories: string[]; days: number; customer_questions?: string[] }) =>
    import('./projectsApi').then(m => m.projectsApi.generateDocument(projectId, data)),
  mergeDocuments: (projectId: string, data: { output_type: 'prd' | 'prfaq' | 'custom'; title: string; instructions: string; selected_document_ids: string[]; selected_persona_ids?: string[]; use_feedback?: boolean; feedback_sources?: string[]; feedback_categories?: string[]; days?: number }) =>
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

  // S3 Import File Explorer
  getS3ImportSources: () => fetchApi<{ sources: S3ImportSource[]; bucket: string | null }>('/s3-import/sources'),
  
  createS3ImportSource: (name: string) =>
    fetchApi<{ success: boolean; source?: S3ImportSource; message?: string }>('/s3-import/sources', {
      method: 'POST',
      body: JSON.stringify({ name })
    }),
  
  getS3ImportFiles: (params?: { source?: string; include_processed?: boolean }) => {
    const searchParams = new URLSearchParams()
    if (params?.source) searchParams.set('source', params.source)
    if (params?.include_processed) searchParams.set('include_processed', 'true')
    return fetchApi<{ files: S3ImportFile[]; bucket: string | null }>(`/s3-import/files?${searchParams}`)
  },
  
  getS3UploadUrl: (filename: string, source: string, contentType?: string) =>
    fetchApi<{ success: boolean; upload_url?: string; key?: string; message?: string }>('/s3-import/upload-url', {
      method: 'POST',
      body: JSON.stringify({ filename, source, content_type: contentType || 'application/octet-stream' })
    }),
  
  deleteS3ImportFile: (key: string) =>
    fetchApi<{ success: boolean; message?: string }>(`/s3-import/file/${encodeURIComponent(key)}`, {
      method: 'DELETE'
    }),

  // Data Explorer - S3 Raw Data Browser
  getDataExplorerBuckets: () =>
    fetchApi<{ buckets: Array<{ id: string; name: string; label: string; description: string }> }>('/data-explorer/buckets'),

  getDataExplorerS3: (prefix?: string, bucket?: string) => {
    const params = new URLSearchParams()
    if (prefix) params.set('prefix', prefix)
    if (bucket) params.set('bucket', bucket)
    return fetchApi<{ 
      objects: Array<{ key: string; fullKey?: string; size: number; lastModified: string; isFolder: boolean }>
      bucket: string
      bucketId: string
      bucketLabel: string
      prefix: string 
    }>(`/data-explorer/s3?${params}`)
  },
  
  getDataExplorerS3Preview: (key: string, bucket?: string) => {
    const params = new URLSearchParams()
    params.set('key', key)
    if (bucket) params.set('bucket', bucket)
    return fetchApi<{ content: unknown; size: number; contentType: string; key: string; isPresignedUrl?: boolean }>(`/data-explorer/s3/preview?${params}`)
  },

  saveDataExplorerS3: (key: string, content: string, syncToDynamo?: boolean, bucket?: string) =>
    fetchApi<{ success: boolean; message?: string; synced?: boolean }>('/data-explorer/s3', {
      method: 'PUT',
      body: JSON.stringify({ key, content, sync_to_dynamo: syncToDynamo, bucket })
    }),

  deleteDataExplorerS3: (key: string, bucket?: string) => {
    const params = new URLSearchParams()
    params.set('key', key)
    if (bucket) params.set('bucket', bucket)
    return fetchApi<{ success: boolean; message?: string }>(`/data-explorer/s3?${params}`, {
      method: 'DELETE'
    })
  },

  // Data Explorer - DynamoDB Feedback CRUD
  saveDataExplorerFeedback: (feedbackId: string, data: Partial<FeedbackItem>, syncToS3?: boolean) =>
    fetchApi<{ success: boolean; message?: string; synced?: boolean }>('/data-explorer/feedback', {
      method: 'PUT',
      body: JSON.stringify({ feedback_id: feedbackId, data, sync_to_s3: syncToS3 })
    }),

  deleteDataExplorerFeedback: (feedbackId: string) =>
    fetchApi<{ success: boolean; message?: string }>(`/data-explorer/feedback?feedback_id=${encodeURIComponent(feedbackId)}`, {
      method: 'DELETE'
    }),

  // Feedback Form (Embeddable) - Legacy single form
  getFeedbackFormConfig: () => fetchApi<{ success: boolean; config: FeedbackFormConfig }>('/feedback-form/config'),
  
  saveFeedbackFormConfig: (config: FeedbackFormConfig) =>
    fetchApi<{ success: boolean; message: string }>('/feedback-form/config', {
      method: 'PUT',
      body: JSON.stringify(config)
    }),
  
  submitFeedbackForm: (data: { text: string; rating?: number; email?: string; name?: string; page_url?: string; custom_fields?: Record<string, string> }) =>
    fetchApi<{ success: boolean; feedback_id?: string; message: string }>('/feedback-form/submit', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  getFeedbackFormEmbed: (apiEndpoint: string) =>
    fetchApi<{ success: boolean; script_embed: string; iframe_embed: string }>(`/feedback-form/embed?api_endpoint=${encodeURIComponent(apiEndpoint)}`),

  // Feedback Forms (Multiple forms management)
  getFeedbackForms: () => fetchApi<{ success: boolean; forms: FeedbackForm[] }>('/feedback-forms'),
  
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

  // User Administration (admin only)
  getUsers: () => fetchApi<{ success: boolean; users: CognitoUser[]; message?: string }>('/users'),
  
  createUser: (data: { username: string; email: string; name?: string; group: 'admins' | 'users' }) =>
    fetchApi<{ success: boolean; message: string; user?: CognitoUser }>('/users', {
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

export function getDateRangeParams(range: string, customRange?: { start: string; end: string } | null): { days?: number; start_date?: string; end_date?: string } {
  if (range === 'custom' && customRange) {
    return {
      start_date: customRange.start,
      end_date: customRange.end,
    }
  }
  return { days: getDaysFromRange(range) }
}
