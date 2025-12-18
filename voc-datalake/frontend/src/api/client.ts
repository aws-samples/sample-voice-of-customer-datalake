import { useConfigStore } from '../store/configStore'

const getBaseUrl = () => {
  const { config } = useConfigStore.getState()
  return config.apiEndpoint || '/api'
}

// Cache for streaming URL (fetched from backend)
let cachedStreamUrl: string | null = null

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/+$/, '')  // Remove trailing slashes
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`)
  }
  
  return response.json()
}

// Fetch streaming URL from backend config (cached)
async function getStreamUrl(): Promise<string> {
  if (cachedStreamUrl !== null) return cachedStreamUrl
  
  try {
    const config = await fetchApi<{ chat_stream_url: string }>('/projects/config')
    cachedStreamUrl = config.chat_stream_url || ''
    return cachedStreamUrl
  } catch {
    cachedStreamUrl = ''
    return ''
  }
}

export interface FeedbackItem {
  feedback_id: string
  source_id: string
  source_platform: string
  source_channel: string
  source_url?: string
  brand_name: string
  source_created_at: string
  processed_at: string
  original_text: string
  original_language: string
  normalized_text?: string
  rating?: number
  category: string
  subcategory?: string
  journey_stage: string
  sentiment_label: string
  sentiment_score: number
  urgency: string
  impact_area: string
  problem_summary?: string
  problem_root_cause_hypothesis?: string
  direct_customer_quote?: string
  persona_name?: string
  persona_type?: string
}

export interface MetricsSummary {
  period_days: number
  total_feedback: number
  avg_sentiment: number
  urgent_count: number
  daily_totals: { date: string; count: number }[]
  daily_sentiment: { date: string; avg_sentiment: number; count: number }[]
}

export interface SentimentBreakdown {
  period_days: number
  total: number
  breakdown: Record<string, number>
  percentages: Record<string, number>
}

export interface CategoryBreakdown {
  period_days: number
  categories: Record<string, number>
}

export interface SourceBreakdown {
  period_days: number
  sources: Record<string, number>
}

export interface IntegrationStatus {
  trustpilot: {
    configured: boolean
    webhook_url: string
    last_webhook_received?: string
    credentials_set: string[]
  }
  [key: string]: {
    configured: boolean
    webhook_url?: string
    last_webhook_received?: string
    credentials_set: string[]
  }
}

export interface ScraperConfig {
  id: string
  name: string
  enabled: boolean
  base_url: string
  urls: string[]
  frequency_minutes: number
  extraction_method?: 'css' | 'jsonld'
  template?: string
  container_selector: string
  text_selector: string
  title_selector?: string
  rating_selector?: string
  rating_attribute?: string
  date_selector?: string
  author_selector?: string
  link_selector?: string
  pagination: {
    enabled: boolean
    param: string
    max_pages: number
    start: number
  }
  last_run?: string
  items_found?: number
}

export interface ScraperTemplate {
  id: string
  name: string
  description: string
  icon: string
  extraction_method: 'css' | 'jsonld'
  url_pattern: string
  url_placeholder: string
  supports_pagination: boolean
  pagination: {
    enabled: boolean
    param: string
    start: number
    max_pages: number
  }
  config: Partial<ScraperConfig>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: FeedbackItem[]
  timestamp: string
  filters?: {
    source?: string
    category?: string
    sentiment?: string
    tags?: string[]
  }
}

export interface ChatConversation {
  id: string
  title: string
  messages: ChatMessage[]
  filters: {
    source?: string
    category?: string
    sentiment?: string
    tags?: string[]
  }
  createdAt: string
  updatedAt: string
}

export interface EntitiesResponse {
  period_days: number
  feedback_count: number
  entities: {
    keywords: Record<string, number>
    categories: Record<string, number>
    issues: Record<string, number>
    personas: Record<string, number>
    sources: Record<string, number>
  }
}

export const api = {
  // Feedback
  getFeedback: (params: { days?: number; source?: string; category?: string; sentiment?: string; limit?: number }) => {
    const searchParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) searchParams.set(key, String(value))
    })
    return fetchApi<{ count: number; items: FeedbackItem[] }>(`/feedback?${searchParams}`)
  },
  
  getFeedbackById: (id: string) => fetchApi<FeedbackItem>(`/feedback/${id}`),
  
  getUrgentFeedback: (params: { days?: number; limit?: number }) => {
    const searchParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) searchParams.set(key, String(value))
    })
    return fetchApi<{ count: number; items: FeedbackItem[] }>(`/feedback/urgent?${searchParams}`)
  },
  
  searchFeedback: (params: { q: string; days?: number; limit?: number }) => {
    const searchParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) searchParams.set(key, String(value))
    })
    return fetchApi<{ count: number; items: FeedbackItem[]; entities: EntitiesResponse['entities']; query: string }>(`/feedback/search?${searchParams}`)
  },
  
  getSimilarFeedback: (id: string, limit?: number) => {
    const searchParams = new URLSearchParams()
    if (limit) searchParams.set('limit', String(limit))
    return fetchApi<{ source_feedback_id: string; count: number; items: FeedbackItem[] }>(`/feedback/${id}/similar?${searchParams}`)
  },
  
  getEntities: (params: { days?: number; limit?: number; source?: string }) => {
    const searchParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) searchParams.set(key, String(value))
    })
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
    
    if (!streamEndpoint) {
      // Fall back to regular API if streaming not configured
      return api.chat(message, context)
    }
    
    const response = await fetch(`${streamEndpoint.replace(/\/+$/, '')}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context, days: days || 7 })
    })
    
    if (!response.ok) {
      throw new Error(`Stream API Error: ${response.status}`)
    }
    
    return response.json()
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

  // Projects
  getProjects: () => fetchApi<{ projects: Project[] }>('/projects'),
  
  createProject: (data: { name: string; description?: string; filters?: Record<string, unknown> }) =>
    fetchApi<{ success: boolean; project: Project }>('/projects', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  getProject: (id: string) => fetchApi<ProjectDetail>(`/projects/${id}`),
  
  updateProject: (id: string, data: Partial<Project>) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  deleteProject: (id: string) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  
  generatePersonas: (projectId: string, filters?: {
    sources?: string[]
    categories?: string[]
    sentiments?: string[]
    persona_count?: number
    custom_instructions?: string
    days?: number
  }) =>
    fetchApi<{ success: boolean; personas: ProjectPersona[]; analysis?: { research: string; validation: string } }>(`/projects/${projectId}/personas/generate`, {
      method: 'POST',
      body: JSON.stringify(filters || {})
    }),
  
  // Persona CRUD
  createPersona: (projectId: string, persona: Omit<ProjectPersona, 'persona_id' | 'created_at'>) =>
    fetchApi<{ success: boolean; persona: ProjectPersona }>(`/projects/${projectId}/personas`, {
      method: 'POST',
      body: JSON.stringify(persona)
    }),
  
  updatePersona: (projectId: string, personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  deletePersona: (projectId: string, personaId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, {
      method: 'DELETE'
    }),
  
  importPersona: (projectId: string, data: { input_type: 'pdf' | 'image' | 'text'; content: string; media_type?: string }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/personas/import`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  generatePRD: (projectId: string, data: { feature_idea: string; title?: string }) =>
    fetchApi<{ success: boolean; document: ProjectDocument }>(`/projects/${projectId}/prd/generate`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  generatePRFAQ: (projectId: string, data: { feature_idea: string; title?: string }) =>
    fetchApi<{ success: boolean; document: ProjectDocument }>(`/projects/${projectId}/prfaq/generate`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  projectChat: (projectId: string, message: string, selectedPersonas?: string[], selectedDocuments?: string[]) =>
    fetchApi<{ success: boolean; response: string; mentioned_personas?: string[]; selected_personas?: string[]; referenced_documents?: string[]; context?: { feedback_count: number; persona_count: number; document_count: number } }>(`/projects/${projectId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ 
        message,
        selected_personas: selectedPersonas,
        selected_documents: selectedDocuments
      })
    }),
  
  // Streaming chat via Lambda Function URL (bypasses API Gateway 29s timeout)
  projectChatStream: async (
    projectId: string, 
    message: string, 
    selectedPersonas?: string[], 
    selectedDocuments?: string[]
  ): Promise<{ success: boolean; response: string; mentioned_personas?: string[]; selected_personas?: string[]; referenced_documents?: string[]; context?: { feedback_count: number; persona_count: number; document_count: number } }> => {
    // Get streaming URL from backend config (auto-configured via CDK)
    const streamEndpoint = await getStreamUrl()
    
    if (!streamEndpoint) {
      // Fall back to regular API if streaming not configured
      return api.projectChat(projectId, message, selectedPersonas, selectedDocuments)
    }
    
    const response = await fetch(`${streamEndpoint.replace(/\/+$/, '')}/projects/${projectId}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        selected_personas: selectedPersonas,
        selected_documents: selectedDocuments
      })
    })
    
    if (!response.ok) {
      throw new Error(`Stream API Error: ${response.status}`)
    }
    
    return response.json()
  },
  
  runResearch: (projectId: string, data: { 
    question: string
    title?: string
    sources?: string[]
    categories?: string[]
    sentiments?: string[]
    days?: number
    // Optional context selection
    selected_persona_ids?: string[]
    selected_document_ids?: string[]
  }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/research`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  generateDocument: (projectId: string, data: {
    doc_type: 'prd' | 'prfaq'
    title: string
    feature_idea: string
    data_sources: { feedback: boolean; personas: boolean; documents: boolean; research: boolean }
    selected_persona_ids: string[]
    selected_document_ids: string[]
    feedback_sources: string[]
    feedback_categories: string[]
    days: number
    customer_questions?: string[]
  }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/document`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  mergeDocuments: (projectId: string, data: {
    output_type: 'prd' | 'prfaq' | 'custom'
    title: string
    instructions: string
    selected_document_ids: string[]
    selected_persona_ids?: string[]
    use_feedback?: boolean
    feedback_sources?: string[]
    feedback_categories?: string[]
    days?: number
  }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/documents/merge`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  getJobStatus: (projectId: string, jobId: string) =>
    fetchApi<ProjectJob>(`/projects/${projectId}/jobs/${jobId}`),
  
  getJobs: (projectId: string) =>
    fetchApi<{ success: boolean; jobs: ProjectJob[] }>(`/projects/${projectId}/jobs`),
  
  dismissJob: (projectId: string, jobId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/jobs/${jobId}`, {
      method: 'DELETE'
    }),
  
  createDocument: (projectId: string, data: { title: string; content: string; document_type?: string }) =>
    fetchApi<{ success: boolean; document: ProjectDocument }>(`/projects/${projectId}/documents`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  updateDocument: (projectId: string, documentId: string, data: { title?: string; content?: string }) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  deleteDocument: (projectId: string, documentId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, {
      method: 'DELETE'
    }),

  // Prioritization
  getPrioritizationScores: () => 
    fetchApi<{ scores: Record<string, PrioritizationScore> }>('/projects/prioritization'),
  
  savePrioritizationScores: (scores: Record<string, PrioritizationScore>) =>
    fetchApi<{ success: boolean }>('/projects/prioritization', {
      method: 'PUT',
      body: JSON.stringify({ scores })
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
}

// Project types
export interface ProjectJob {
  success?: boolean
  job_id: string
  job_type: 'research' | 'generate_personas' | 'generate_prd' | 'generate_prfaq' | 'merge_documents' | 'import_persona'
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  current_step?: string
  created_at: string
  updated_at?: string
  completed_at?: string
  error?: string
  result?: {
    document_id?: string
    persona_id?: string
    title?: string
    personas?: ProjectPersona[]
  }
}

export interface ProjectPersona {
  persona_id: string
  name: string
  tagline: string
  demographics: { age_range?: string; occupation?: string; tech_level?: string; bio?: string; location?: string; income_bracket?: string; education?: string; family_status?: string }
  quote: string
  goals: string[]
  frustrations: string[]
  behaviors: string[] | { current_solutions?: string[]; tools_used?: string[]; activity_frequency?: string; tech_savviness?: string; decision_style?: string }
  needs: string[]
  // Scenario can be string (legacy) or object (new format)
  scenario: string | { title?: string; narrative?: string; trigger?: string; outcome?: string }
  created_at: string
  // Enhanced persona fields (8-section template)
  confidence?: 'high' | 'medium' | 'low'
  feedback_count?: number
  avatar_url?: string
  avatar_prompt?: string
  // Section 1: Identity & Demographics
  identity?: { 
    age_range?: string
    location?: string
    occupation?: string
    income_bracket?: string
    education?: string
    family_status?: string
    bio?: string 
  }
  // Section 2: Goals & Motivations
  goals_motivations?: { 
    primary_goal?: string
    secondary_goals?: string[]
    success_definition?: string
    underlying_motivations?: string[] 
  }
  // Section 3: Pain Points & Frustrations
  pain_points?: { 
    current_challenges?: string[]
    blockers?: string[]
    workarounds?: string[]
    emotional_impact?: string 
  }
  // Section 4: Behaviors & Habits (object format)
  behaviors_detail?: {
    current_solutions?: string[]
    tools_used?: string[]
    activity_frequency?: string
    tech_savviness?: string
    decision_style?: string
  }
  // Section 5: Context & Environment
  context_environment?: { 
    usage_context?: string
    devices?: string[]
    time_constraints?: string
    social_context?: string
    influencers?: string[]
  }
  // Section 6: Representative Quotes
  quotes?: Array<{ text: string; context?: string }>
  // Section 7: Scenario (already defined above)
  // Section 8: Research Notes (user-editable) - can be strings or objects
  research_notes?: Array<string | { note_id?: string; text: string; author?: string; created_at?: string; tags?: string[] }>
  // Metadata
  supporting_evidence?: string[]
  source_breakdown?: Record<string, number>
}

export interface ProjectDocument {
  document_id: string
  document_type: 'prd' | 'prfaq' | 'research' | 'custom'
  title: string
  content: string
  feature_idea?: string
  question?: string
  created_at: string
  updated_at?: string
}

export interface Project {
  project_id: string
  name: string
  description: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  persona_count: number
  document_count: number
  filters?: Record<string, unknown>
  kiro_export_prompt?: string
}

export interface ProjectDetail {
  project: Project
  personas: ProjectPersona[]
  documents: ProjectDocument[]
}

export interface PrioritizationScore {
  document_id: string
  impact: number
  time_to_market: number
  confidence: number
  strategic_fit: number
  notes: string
}

export interface S3ImportSource {
  name: string
  display_name: string
}

export interface S3ImportFile {
  key: string
  filename: string
  source: string
  size: number
  last_modified: string
  status: 'pending' | 'processed'
}

export interface FeedbackFormConfig {
  enabled: boolean
  title: string
  description: string
  question: string
  placeholder: string
  rating_enabled: boolean
  rating_type: 'stars' | 'numeric' | 'emoji'
  rating_max: number
  submit_button_text: string
  success_message: string
  theme: {
    primary_color: string
    background_color: string
    text_color: string
    border_radius: string
  }
  collect_email: boolean
  collect_name: boolean
  custom_fields: Array<{ id: string; label: string; type: string; required: boolean }>
  brand_name: string
}

export interface FeedbackForm {
  form_id: string
  name: string
  enabled: boolean
  title: string
  description: string
  question: string
  placeholder: string
  rating_enabled: boolean
  rating_type: 'stars' | 'numeric' | 'emoji'
  rating_max: number
  submit_button_text: string
  success_message: string
  theme: {
    primary_color: string
    background_color: string
    text_color: string
    border_radius: string
  }
  collect_email: boolean
  collect_name: boolean
  custom_fields: Array<{ id: string; label: string; type: string; required: boolean }>
  category: string
  subcategory: string
  created_at: string
  updated_at: string
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
