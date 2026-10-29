/**
 * Unified assistant — SPA mirror of the stream Lambda's wire contract.
 *
 * LOCKSTEP with `lambda/stream/src/assistant/contract.ts` (the source of the
 * prose describing each constant). `contract.lockstep.test.ts` parses that
 * file and fails when these values drift.
 */
import { z } from 'zod'

export const AGUI_PROTOCOL_VERSION = '1.0'

export const PAGE_KINDS = [
  'home',
  'dashboard',
  'feedback',
  'categories',
  'problems',
  'chat',
  'projects',
  'project',
  'prioritization',
  'data-explorer',
  'scrapers',
  'feedback-forms',
  'settings',
  'memory',
  'agents',
  'agent',
  'company',
  'radar',
  /** /participants: participant lists (docs/participants.md); add many people through one approval card. */
  'participants',
  'other',
] as const
export type PageKind = (typeof PAGE_KINDS)[number]

export const TOOL_PACKS = [
  'core',
  'insights',
  'project',
  'forms',
  'prioritization',
  'scrapers',
  'settings',
  'memory',
  'agents',
  'company',
  'participants',
] as const
export type ToolPack = (typeof TOOL_PACKS)[number]

export const PAGE_TOOL_PACKS: Record<PageKind, readonly ToolPack[]> = {
  home: ['core', 'insights'],
  dashboard: ['core', 'insights'],
  feedback: ['core', 'insights'],
  categories: ['core', 'insights'],
  problems: ['core', 'insights'],
  chat: ['core', 'insights'],
  projects: ['core', 'insights'],
  project: ['core', 'project'],
  prioritization: ['core', 'prioritization'],
  'data-explorer': ['core', 'insights'],
  scrapers: ['core', 'scrapers'],
  'feedback-forms': ['core', 'forms'],
  settings: ['core', 'settings', 'company'],
  memory: ['core', 'memory'],
  agents: ['core', 'agents', 'memory'],
  agent: ['core', 'agents', 'memory'],
  company: ['core', 'company'],
  radar: ['core', 'insights', 'scrapers'],
  participants: ['core', 'participants'],
  other: ['core', 'insights'],
}

export const ADMIN_ONLY_PACKS: readonly ToolPack[] = ['settings']

export function packsForPage(kind: PageKind, isAdmin: boolean): ToolPack[] {
  return PAGE_TOOL_PACKS[kind].filter((pack) => isAdmin || !ADMIN_ONLY_PACKS.includes(pack))
}

export const SERVER_TOOLS = {
  core: ['search_feedback', 'get_metrics', 'get_feedback_item', 'list_projects', 'get_project', 'suggest_navigation', 'web_search', 'list_categories', 'list_dimensions', 'search_memory', 'get_plan', 'plan_catalogue', 'plan_lookup', 'get_radar'],
  insights: ['get_urgent_feedback', 'list_feedback', 'get_entities', 'get_resolved_problems'],
  project: ['get_documents', 'get_persona', 'get_product_context', 'list_project_jobs', 'consult_personas'],
  forms: ['list_feedback_forms', 'get_feedback_form_stats', 'get_feedback_form_submissions'],
  prioritization: ['get_prioritization'],
  scrapers: ['list_scrapers', 'get_scraper_status', 'analyze_scraper_url', 'get_source_run', 'find_app_store_app'],
  settings: ['get_categories_config', 'get_brand_settings', 'list_users', 'get_user_access'],
  memory: ['get_memory_review'],
  agents: ['list_agents', 'get_agent', 'get_workflow', 'list_agent_runs', 'get_agent_run', 'validate_workflow'],
  company: ['get_company_context', 'get_my_context', 'get_design_system'],
  participants: ['list_participant_lists'],
} as const satisfies Record<ToolPack, readonly string[]>

export const CLIENT_TOOLS = {
  core: ['create_project', 'remember', 'update_company_memory', 'propose_plan', 'cancel_plan'],
  insights: ['set_problem_resolved', 'set_feedback_category'],
  project: [
    'update_document',
    'create_document',
    'delete_document',
    'update_persona',
    'add_persona_note',
    'update_project',
    'update_product_context',
    'start_research',
    'generate_document',
    'generate_personas',
    'merge_documents',
    'build_prototype',
  ],
  forms: ['update_feedback_form'],
  prioritization: [],
  scrapers: ['run_scraper', 'create_scraper', 'update_scraper', 'create_app_connector', 'run_source', 'set_source_enabled', 'import_reviews', 'save_radar_brands', 'run_radar_scan'],
  settings: ['save_brand_settings', 'create_user', 'create_users', 'update_user', 'set_user_access'],
  memory: ['forget_memory', 'confirm_memory', 'merge_memories', 'resolve_memory_conflict'],
  agents: [
    'create_agent',
    'update_agent',
    'enable_agent',
    'disable_agent',
    'run_agent',
    'cancel_agent_run',
    'create_workflow',
    'update_workflow',
    'duplicate_workflow',
  ],
  company: ['update_company_context', 'update_my_context', 'update_design_system'],
  participants: ['create_participant_list', 'add_participants'],
} as const satisfies Record<ToolPack, readonly string[]>

export type ServerToolName = (typeof SERVER_TOOLS)[ToolPack][number]
export type ClientToolName = (typeof CLIENT_TOOLS)[ToolPack][number]

export const DESTRUCTIVE_CLIENT_TOOLS: readonly ClientToolName[] = ['delete_document', 'forget_memory', 'merge_memories']
export const ADMIN_ONLY_CLIENT_TOOLS: readonly ClientToolName[] = [
  'run_scraper',
  'create_scraper',
  'update_scraper',
  'create_app_connector',
  'run_source',
  'set_source_enabled',
  'import_reviews',
  'save_radar_brands',
  'run_radar_scan',
  'save_brand_settings',
  'create_user',
  'create_users',
  'update_user',
  'set_user_access',
  'create_agent',
  'update_agent',
  'enable_agent',
  'disable_agent',
  // POST /agents/{id}/run and /runs/{run_id}/cancel are admin at REST (agents_handler._require_run_permission
  // / _require_admin): a non-admin never gets the tool, a plan step forwards admins only after the re-check.
  'run_agent',
  'cancel_agent_run',
  'create_workflow',
  'update_workflow',
  'duplicate_workflow',
  'update_company_context',
  'update_design_system',
]

/** Read-only server tools that need the `admins` group (the wrapped route is admin-only). */
export const ADMIN_ONLY_SERVER_TOOLS: readonly ServerToolName[] = ['analyze_scraper_url', 'list_users', 'get_user_access', 'get_source_run']

/** Plan-mode tools named before they are implemented (all built now, so empty; see the server file). */
export const PLAN_TOOL_NAMES = {
  server: {},
  client: {},
  adminOnlyClient: [],
} as const satisfies {
  server: Partial<Record<ToolPack, readonly string[]>>
  client: Partial<Record<ToolPack, readonly string[]>>
  adminOnlyClient: readonly string[]
}

export const INTERRUPT_REASON_TOOL_APPROVAL = 'tool_approval'
export const INTERRUPT_ID_PREFIX = 'approval:'
export const INTERRUPT_TTL_MINUTES = 30

export const TOOL_OUTCOME_STATUSES = ['executed', 'failed', 'declined'] as const
export type ToolOutcomeStatus = (typeof TOOL_OUTCOME_STATUSES)[number]

export const INTERRUPT_REASON_PLAN_APPROVAL = 'plan_approval'
export const PLAN_INTERRUPT_ID_PREFIX = 'plan:'

/** Content of the `tool` message the SPA sends after an approval card resolves. */
export const toolOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('executed'), summary: z.string(), data: z.unknown().optional() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
  z.object({ status: z.literal('declined'), reason: z.string().optional() }),
])
export type ToolOutcome = z.infer<typeof toolOutcomeSchema>

export const CUSTOM_EVENTS = {
  context: 'assistant.context',
  sources: 'assistant.sources',
  navigation: 'assistant.navigation',
  session: 'assistant.session',
  plan: 'assistant.plan',
  stopped: 'assistant.stopped',
} as const

/** Stored run status of a session, written by the stream Lambda while a run streams. */
export const SESSION_RUN_STATUSES = ['running', 'finished', 'failed', 'interrupted', 'stopped'] as const

/**
 * A stored `running` session older than this (seconds since its last write) is
 * dead: the stream Lambda's 15-minute timeout plus a minute. Mirrors the stream
 * contract and chat_handler.STALE_RUN_SECONDS.
 */
export const STALE_RUN_SECONDS = 960

export const MAX_ID_LENGTH = 128

export const ALL_TIME_DAYS = 0

/**
 * The filters a page shows, from its URL query, so the assistant sees what is on screen (5.35):
 * Categories (`q` … `tag`, pages/Categories/useCategoryFilters.ts) and Problem Analysis
 * (`source`, `category`, `subcategory`, `urgent`, `resolved`, `similarity`). The time range is
 * not here: it travels as `forwardedProps.days` / `dateBasis` on every page.
 */
export const PAGE_FILTER_KEYS = [
  'q', 'category', 'subcategory', 'source', 'sentiment', 'rating', 'rating_dir', 'urgent', 'channel', 'dims', 'tag',
  'resolved', 'similarity',
] as const
export const MAX_PAGE_FILTER_CHARS = 200

export const pageContextSchema = z.object({
  kind: z.enum(PAGE_KINDS),
  path: z.string().max(200),
  projectId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  feedbackId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  agentId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  tab: z.string().max(64).optional(),
  title: z.string().max(120).optional(),
  filters: z.partialRecord(z.enum(PAGE_FILTER_KEYS), z.string().min(1).max(MAX_PAGE_FILTER_CHARS)).optional(),
})
export type PageContext = z.infer<typeof pageContextSchema>

/** `@persona` / `@all` / `#document` on a project page (see the server file and docs/assistant-mentions.md). */
export const MENTION_LIMITS = { maxPersonas: 6, maxDocuments: 3, maxDocumentVersion: 100_000 } as const
export const MENTION_ALL_PERSONAS = 'all'
/** Tool call ids of the server's persona round (one `consult_personas` call per mentioned persona). */
export const MENTION_TOOL_CALL_PREFIX = 'mention_'

export const mentionsSchema = z.object({
  personas: z.union([
    z.literal(MENTION_ALL_PERSONAS),
    z.array(z.string().min(1).max(MAX_ID_LENGTH)).min(1).max(MENTION_LIMITS.maxPersonas),
  ]).optional(),
  documents: z.array(z.object({
    document_id: z.string().min(1).max(MAX_ID_LENGTH),
    version: z.number().int().min(1).max(MENTION_LIMITS.maxDocumentVersion).optional(),
  })).min(1).max(MENTION_LIMITS.maxDocuments).optional(),
})
export type Mentions = z.infer<typeof mentionsSchema>

export const forwardedPropsSchema = z.object({
  page: pageContextSchema,
  mentions: mentionsSchema.optional(),
  days: z.number().int().min(ALL_TIME_DAYS).max(9999).optional(),
  dateBasis: z.enum(['imported', 'review']).optional(),
  responseLanguage: z.string().max(16).optional(),
  useWebSearch: z.boolean().optional(),
})
export type ForwardedProps = z.infer<typeof forwardedPropsSchema>

export const LIMITS = {
  maxMessages: 300,
  maxUserMessageChars: 8000,
  maxToolMessageChars: 20_000,
  maxAttachments: 5,
  maxAttachmentBase64Chars: 2_800_000,
} as const
