// API Types - extracted from client.ts to reduce file size

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

/**
 * Which date the `days` window applies to on time-filtered endpoints.
 *
 * - 'imported': when the item entered the data lake (historical default)
 * - 'review':   when the customer originally wrote the feedback
 *               (`source_created_at`) — excludes old reviews that were only
 *               imported recently
 */
export type DateBasis = 'imported' | 'review'

/**
 * Filter shape shared by feedback list endpoints.
 *
 * Used by `/feedback`, `/feedback/urgent`, and `/feedback/search`. Each filter
 * narrows the result set independently; combine them via AND on the server.
 */
export interface FeedbackFilters {
  days?: number
  date_basis?: DateBasis
  source?: string
  category?: string
  sentiment?: string
}

/**
 * Query parameters for the paginated `/feedback` list endpoint.
 *
 * Pagination is offset-based within a candidate window (see backend
 * `list_feedback` for window semantics). `offset` of 0 is the first page.
 */
export interface FeedbackListParams extends FeedbackFilters {
  limit?: number
  offset?: number
}

/**
 * Response envelope for the paginated `/feedback` list endpoint.
 *
 * - `count` is the size of the returned page (0..limit).
 * - `total` is the size of the filtered candidate window — `hasMore` should be
 *   computed as `loaded < total`, not `count < limit`.
 * - `offset` and `limit` echo the applied request parameters.
 * - `is_partial_window` is true when the candidate window was truncated by the
 *   backend's MAX_FEEDBACK_OFFSET cap, meaning more matching records may exist
 *   beyond what was counted. UI should treat `total` as a lower bound in that
 *   case.
 */
export interface FeedbackListResponse {
  count: number
  total: number
  offset: number
  limit: number
  is_partial_window: boolean
  items: FeedbackItem[]
}

/**
 * Response envelope for `/feedback/urgent`. Not paginated — returns up to
 * `limit` items in one shot.
 */
export interface UrgentFeedbackResponse {
  count: number
  items: FeedbackItem[]
}

export interface MetricsSummary {
  period_days: number
  total_feedback: number
  avg_sentiment: number
  urgent_count: number
  /**
   * True when the metrics were computed from a truncated raw-item scan
   * (review-date basis or source filter on a very large window) and the
   * counts are a lower bound rather than exact aggregates.
   */
  is_partial?: boolean
  daily_totals: {
    date: string;
    count: number
  }[]
  daily_sentiment: {
    date: string;
    avg_sentiment: number;
    count: number
  }[]
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
  webscraper: {
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

export interface ProjectJob {
  success?: boolean
  job_id: string
  job_type: 'research' | 'generate_personas' | 'generate_prd' | 'generate_prfaq' | 'generate_product_report' | 'build_prototype' | 'merge_documents' | 'import_persona'
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
  created_at: string
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
  // Section 4: Behaviors & Habits
  behaviors?: {
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
  quotes?: Array<{
    text: string;
    context?: string
  }>
  // Section 7: Scenario/User Story
  scenario?: {
    title?: string
    narrative?: string
    trigger?: string
    outcome?: string
  }
  // Section 8: Research Notes
  research_notes?: Array<string | {
    note_id?: string;
    text: string;
    author?: string;
    created_at?: string;
    tags?: string[]
  }>
  // Metadata
  supporting_evidence?: string[]
  source_breakdown?: Record<string, number>
}

export interface ProjectDocument {
  document_id: string
  document_type: 'prd' | 'prfaq' | 'research' | 'custom' | 'product_report' | 'prototype'
  title: string
  // New (S3-only) HTML prototypes have NO `content` — the HTML lives at
  // `prototype_url` on CloudFront. Legacy prototypes (JSON specs, or
  // pre-migration HTML) and all non-prototype document types still use
  // `content` as before.
  content: string
  feature_idea?: string
  question?: string
  // For prototypes: 'html' → this is a self-contained HTML document, served
  // via `prototype_url` (new) or rendered from `content` via a sandboxed
  // iframe srcDoc (legacy fallback). Absent → legacy JSON spec rendered via
  // PrototypeRenderer.
  prototype_format?: 'html' | string
  // CloudFront URL for the generated prototype HTML (new prototypes only —
  // served from the /prototypes/* cache behavior with its own permissive CSP).
  // Absent on legacy prototypes; callers fall back to `content`/srcDoc.
  prototype_url?: string
  created_at: string
  updated_at?: string
}

export type ProductLifecycleState = '' | 'idea' | 'mvp' | 'beta' | 'ga' | 'mature'

export interface ProductContext {
  product_name: string
  one_liner: string
  target_users: string
  problem_solved: string
  current_state: ProductLifecycleState
  // The following are free-text comments — multi-line strings, not arrays.
  key_features: string
  differentiators: string
  known_limitations: string
  non_goals: string
  success_metrics: string
  free_form_notes: string
  updated_at?: string
}

export type ProductDocStatus = 'pending' | 'extracting' | 'ready' | 'failed'

export interface ProductDoc {
  doc_id: string
  filename: string
  content_type: string
  size_bytes: number
  status: ProductDocStatus
  error: string | null
  extracted_chars: number
  created_at: string
}

export interface ProductInterviewTurnResponse {
  assistant_message: string
  applied_patch: Partial<ProductContext>
  context: ProductContext
}

export interface ProductReportResponse {
  success: boolean
  document: ProjectDocument
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

/** Shared form configuration fields used by both FeedbackFormConfig and FeedbackForm. */
interface FeedbackFormFields {
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
  custom_fields: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean
  }>
}

export interface FeedbackFormConfig extends FeedbackFormFields {
  enabled: boolean
  brand_name: string
}

export interface FeedbackForm extends FeedbackFormFields {
  form_id: string
  name: string
  enabled: boolean
  category: string
  subcategory: string
  created_at: string
  updated_at: string
}

export interface CognitoUser {
  username: string
  email: string
  name: string
  given_name?: string
  family_name?: string
  status: string
  enabled: boolean
  groups: string[]
  created_at: string | null
  last_modified: string | null
}

// Logs Types
export interface ValidationLogEntry {
  source_platform: string
  message_id: string
  timestamp: string
  log_type: 'validation_failure'
  errors: string[]
  raw_preview?: string
}

export interface ProcessingLogEntry {
  source_platform: string
  message_id: string
  timestamp: string
  log_type: 'processing_error'
  error_type: string
  error_message: string
}

export interface ScraperLogEntry {
  run_id: string
  status: string
  started_at: string
  completed_at?: string
  pages_scraped: number
  items_found: number
  errors: string[]
}

export interface LogsSummary {
  validation_failures: Record<string, number>
  processing_errors: Record<string, number>
  total_validation_failures: number
  total_processing_errors: number
}

/**
 * Metadata for an API token used by external integrations to ingest feedback.
 * The raw token value is only returned once at creation time
 * (see CreateApiTokenResponse).
 */
export interface ApiToken {
  token_id: string
  name: string
  scope: 'read' | 'read-write'
  created_at: string
  last_used_at?: string
  project_id: string
}

/** Response when creating an API token; `token` is the only time the raw value is returned. */
export interface CreateApiTokenResponse {
  success: boolean
  token: string
  token_id: string
  name: string
  message?: string
}


/**
 * A public-web search result returned by the AI chat web_search tool
 * (Amazon Bedrock AgentCore Web Search). Acceptable use requires surfacing
 * these citations alongside any answer that draws on them.
 */
export interface WebSource {
  title: string
  url: string
  text: string
  published_date: string
}
