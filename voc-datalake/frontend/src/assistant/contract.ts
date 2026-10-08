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
  other: ['core', 'insights'],
}

export const ADMIN_ONLY_PACKS: readonly ToolPack[] = ['settings']

export function packsForPage(kind: PageKind, isAdmin: boolean): ToolPack[] {
  return PAGE_TOOL_PACKS[kind].filter((pack) => isAdmin || !ADMIN_ONLY_PACKS.includes(pack))
}

export const SERVER_TOOLS = {
  core: ['search_feedback', 'get_metrics', 'get_feedback_item', 'list_projects', 'get_project', 'suggest_navigation', 'web_search', 'list_categories', 'list_dimensions', 'search_memory'],
  insights: ['get_urgent_feedback', 'list_feedback', 'get_entities', 'get_resolved_problems'],
  project: ['get_documents', 'get_persona', 'get_product_context', 'list_project_jobs', 'consult_personas'],
  forms: ['list_feedback_forms', 'get_feedback_form_stats', 'get_feedback_form_submissions'],
  prioritization: ['get_prioritization'],
  scrapers: ['list_scrapers', 'get_scraper_status'],
  settings: ['get_categories_config', 'get_brand_settings'],
  memory: ['get_memory_review'],
  agents: ['list_agents', 'get_agent', 'get_workflow', 'list_agent_runs', 'get_agent_run', 'validate_workflow'],
  company: ['get_company_context', 'get_my_context', 'get_design_system'],
} as const satisfies Record<ToolPack, readonly string[]>

export const CLIENT_TOOLS = {
  core: ['create_project', 'remember', 'update_company_memory'],
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
  ],
  forms: ['update_feedback_form'],
  prioritization: [],
  scrapers: ['run_scraper'],
  settings: ['save_brand_settings'],
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
} as const satisfies Record<ToolPack, readonly string[]>

export type ServerToolName = (typeof SERVER_TOOLS)[ToolPack][number]
export type ClientToolName = (typeof CLIENT_TOOLS)[ToolPack][number]

export const DESTRUCTIVE_CLIENT_TOOLS: readonly ClientToolName[] = ['delete_document', 'forget_memory', 'merge_memories']
export const ADMIN_ONLY_CLIENT_TOOLS: readonly ClientToolName[] = [
  'run_scraper',
  'save_brand_settings',
  'create_agent',
  'update_agent',
  'enable_agent',
  'disable_agent',
  'create_workflow',
  'update_workflow',
  'duplicate_workflow',
  'update_company_context',
  'update_design_system',
]

export const INTERRUPT_REASON_TOOL_APPROVAL = 'tool_approval'
export const INTERRUPT_ID_PREFIX = 'approval:'
export const INTERRUPT_TTL_MINUTES = 30

export const TOOL_OUTCOME_STATUSES = ['executed', 'failed', 'declined'] as const
export type ToolOutcomeStatus = (typeof TOOL_OUTCOME_STATUSES)[number]

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
} as const

/** Stored run status of a session, written by the stream Lambda while a run streams. */
export const SESSION_RUN_STATUSES = ['running', 'finished', 'failed', 'interrupted'] as const

/** A stored `running` session older than this (seconds since its last write) is dead. */
export const STALE_RUN_SECONDS = 360

export const MAX_ID_LENGTH = 128

export const ALL_TIME_DAYS = 0

export const pageContextSchema = z.object({
  kind: z.enum(PAGE_KINDS),
  path: z.string().max(200),
  projectId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  feedbackId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  agentId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  tab: z.string().max(64).optional(),
  title: z.string().max(120).optional(),
})
export type PageContext = z.infer<typeof pageContextSchema>

export const forwardedPropsSchema = z.object({
  page: pageContextSchema,
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
