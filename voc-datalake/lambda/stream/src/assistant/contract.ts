/**
 * Unified assistant — wire contract shared by the stream Lambda and the SPA.
 *
 * The assistant speaks AG-UI 1.0 over `POST /chat/stream` (SSE through API
 * Gateway). The request body is an AG-UI `RunAgentInput`; this module pins the
 * application-specific parts of it (`forwardedProps`), the tool catalogue and
 * its packs, and the names of the CUSTOM events and interrupt reasons.
 *
 * LOCKSTEP: `frontend/src/assistant/contract.ts` mirrors every exported
 * constant below; `frontend/src/assistant/contract.lockstep.test.ts` parses
 * this file and fails when the two drift. Change both together.
 *
 * Execution model
 *   - SERVER tools are read-only and run inside the stream Lambda.
 *   - CLIENT tools are writes. The server never executes them: it validates the
 *     model's arguments, emits the tool call, and ends the run with an AG-UI
 *     `interrupt` outcome (reason `tool_approval`). The SPA shows an approval
 *     card, and only on human approval executes the write through the existing
 *     REST API with the user's own token, then resumes the thread with a `tool`
 *     message carrying the outcome. The assistant can therefore never exceed
 *     the signed-in user's own permissions, and the Lambda holds no write
 *     grants on business data.
 */
import { z } from 'zod';

export const AGUI_PROTOCOL_VERSION = '1.0';

// ── Pages ──────────────────────────────────────────────────────────────────

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
  /** /radar: other brands (docs/radar.md); loads the scrapers pack so "set up Radar for X" works there. */
  'radar',
  'other',
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

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
] as const;
export type ToolPack = (typeof TOOL_PACKS)[number];

/** Which packs a page loads. `core` is always present. */
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
  other: ['core', 'insights'],
};

/** Packs whose tools are only offered to callers in the `admins` group. */
export const ADMIN_ONLY_PACKS: readonly ToolPack[] = ['settings'];

/** The packs a caller actually gets on a page — the single place admin gating of packs lives. */
export function packsForPage(kind: PageKind, isAdmin: boolean): ToolPack[] {
  return PAGE_TOOL_PACKS[kind].filter((pack) => isAdmin || !ADMIN_ONLY_PACKS.includes(pack));
}

// ── Tools ──────────────────────────────────────────────────────────────────

/** Read-only tools executed in the stream Lambda, by pack. */
export const SERVER_TOOLS = {
  core: [
    'search_feedback', 'get_metrics', 'get_feedback_item', 'list_projects', 'get_project', 'suggest_navigation', 'web_search',
    'list_categories', 'list_dimensions', 'search_memory', 'get_plan', 'plan_catalogue', 'plan_lookup',
    'get_radar',
  ],
  insights: ['get_urgent_feedback', 'list_feedback', 'get_entities', 'get_resolved_problems'],
  project: ['get_documents', 'get_persona', 'get_product_context', 'list_project_jobs', 'consult_personas'],
  forms: ['list_feedback_forms', 'get_feedback_form_stats', 'get_feedback_form_submissions'],
  prioritization: ['get_prioritization'],
  scrapers: ['list_scrapers', 'get_scraper_status', 'analyze_scraper_url', 'get_source_run', 'find_app_store_app'],
  settings: ['get_categories_config', 'get_brand_settings', 'list_users', 'get_user_access'],
  memory: ['get_memory_review'],
  agents: ['list_agents', 'get_agent', 'get_workflow', 'list_agent_runs', 'get_agent_run', 'validate_workflow'],
  company: ['get_company_context', 'get_my_context', 'get_design_system'],
} as const satisfies Record<ToolPack, readonly string[]>;

/** Write tools: proposed by the model, approved by a human, executed by the SPA. */
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
} as const satisfies Record<ToolPack, readonly string[]>;

export type ServerToolName = (typeof SERVER_TOOLS)[ToolPack][number];
export type ClientToolName = (typeof CLIENT_TOOLS)[ToolPack][number];

/** Client tools whose approval card must use destructive styling. */
export const DESTRUCTIVE_CLIENT_TOOLS: readonly ClientToolName[] = ['delete_document', 'forget_memory', 'merge_memories'];

/** Client tools that need the `admins` group (on top of ADMIN_ONLY_PACKS). */
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
];

/**
 * Read-only server tools that need the `admins` group: the route they wrap is
 * admin-only (analyze-url fetches a caller-chosen URL and spends a Bedrock call;
 * the user listings expose the directory). Dropped from a non-admin's toolset
 * and refused when called.
 */
export const ADMIN_ONLY_SERVER_TOOLS: readonly ServerToolName[] = ['analyze_scraper_url', 'list_users', 'get_user_access', 'get_source_run'];

/**
 * Tools introduced for plan mode (docs/assistant-plan-mode.md → "New tools"),
 * named here before they were implemented. Every one is now built and listed
 * in SERVER_TOOLS / CLIENT_TOOLS (and `run_source` in ADMIN_ONLY_CLIENT_TOOLS),
 * so the lists are empty; the export stays because the plan contract
 * (`plan/schema.ts`, `plan_contract.json`) and both mirrors read it, and a
 * later plan-mode tool is named here first the same way.
 */
export const PLAN_TOOL_NAMES = {
  server: {},
  client: {},
  adminOnlyClient: [],
} as const satisfies {
  server: Partial<Record<ToolPack, readonly string[]>>;
  client: Partial<Record<ToolPack, readonly string[]>>;
  adminOnlyClient: readonly string[];
};

// ── Interrupts and custom events ────────────────────────────────────────────

/** `Interrupt.reason` for a write awaiting human approval. */
export const INTERRUPT_REASON_TOOL_APPROVAL = 'tool_approval';
/** `Interrupt.id` is `${INTERRUPT_ID_PREFIX}${toolCallId}`. */
export const INTERRUPT_ID_PREFIX = 'approval:';
/** Minutes an approval stays answerable (`Interrupt.expiresAt`). */
export const INTERRUPT_TTL_MINUTES = 30;

/**
 * `Interrupt.metadata` for a tool approval:
 *   { toolName: ClientToolName, risk: 'write' | 'destructive', projectId?: string }
 *
 * The `tool` message the SPA sends back (content is a JSON string):
 *   { status: 'executed', summary: string, data?: unknown }
 *   { status: 'failed',   error: string }
 *   { status: 'declined', reason?: string }
 */
export const TOOL_OUTCOME_STATUSES = ['executed', 'failed', 'declined'] as const;

/**
 * `Interrupt.reason` for a proposed plan awaiting approval (plan mode). The
 * planner run ends with ONE such interrupt; its `metadata` is
 * `{ plan: VocPlan }` (`plan/schema.ts`, validated) and the same plan was sent
 * just before in the CUSTOM `assistant.plan` event. The SPA shows the plan card;
 * approving calls `POST /agents/plans` (the plan runs in the agent runtime, not
 * in this stream).
 */
export const INTERRUPT_REASON_PLAN_APPROVAL = 'plan_approval';
/** `Interrupt.id` of a plan proposal is `${PLAN_INTERRUPT_ID_PREFIX}${proposalId}`. */
export const PLAN_INTERRUPT_ID_PREFIX = 'plan:';

export const CUSTOM_EVENTS = {
  /** First event after RUN_STARTED: `{ page, packs, model, webSearch }`. */
  context: 'assistant.context',
  /** `{ feedback: FeedbackSource[], web: WebSource[] }` — once, before RUN_FINISHED. */
  sources: 'assistant.sources',
  /** `{ path: string, label: string }` — rendered as a link chip. */
  navigation: 'assistant.navigation',
  /**
   * `{ revision: number }` — right before RUN_FINISHED / RUN_ERROR: the
   * revision of the server's final save of this run (session/recorder.ts). The
   * SPA sends it back as `baseRevision` so its own save never overwrites a
   * newer server revision.
   */
  session: 'assistant.session',
  /**
   * `{ plan: VocPlan }` — a proposed `voc-plan/1` plan (plan mode), right
   * before the RUN_FINISHED whose interrupt has reason `plan_approval`.
   */
  plan: 'assistant.plan',
} as const;

/**
 * Stored run status of a session (`run_status` on the conversations item),
 * written by the stream Lambda while a run streams.
 */
export const SESSION_RUN_STATUSES = ['running', 'finished', 'failed', 'interrupted'] as const;

/**
 * A stored `running` session whose last write is older than this is dead
 * (the stream Lambda's timeout is 900 s — 15 minutes, the API Gateway
 * streaming maximum — and a running run writes at every tool boundary, plus a
 * minute's margin): readers treat it as interrupted, and chat_handler lets the
 * SPA's save through. LOCKSTEP with chat_handler.STALE_RUN_SECONDS.
 */
export const STALE_RUN_SECONDS = 960;

// ── forwardedProps ─────────────────────────────────────────────────────────

export const MAX_ID_LENGTH = 128;

/** `forwardedProps.days = 0` is the all-time window (lambda/shared/api.py `ALL_TIME_DAYS`). */
export const ALL_TIME_DAYS = 0;

export const pageContextSchema = z.object({
  kind: z.enum(PAGE_KINDS),
  /** Router pathname, e.g. `/projects/abc`. Informational only. */
  path: z.string().max(200),
  projectId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  feedbackId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  /** The autonomous agent on screen (`agent` page: agent detail / workflow editor / runs). */
  agentId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  /** Active tab on pages that have tabs (`?tab=` or local state). */
  tab: z.string().max(64).optional(),
  /** Human title of the entity on screen (project name, …), ≤120 chars. */
  title: z.string().max(120).optional(),
});
export type PageContext = z.infer<typeof pageContextSchema>;

export const forwardedPropsSchema = z.object({
  page: pageContextSchema,
  /** Global time-range picker, 0–9999 (0 = all time), default 7. 9999 = MAX_WINDOW_DAYS (pinned in server-tools.test.ts). */
  days: z.number().int().min(ALL_TIME_DAYS).max(9999).optional(),
  dateBasis: z.enum(['imported', 'review']).optional(),
  /** UI language (i18n.language); unsupported values degrade to English. */
  responseLanguage: z.string().max(16).optional(),
  /** Opt-in public web search; ignored when the gateway is not deployed. */
  useWebSearch: z.boolean().optional(),
});
export type ForwardedProps = z.infer<typeof forwardedPropsSchema>;

/** Hard request bounds (the SPA mirrors these). */
export const LIMITS = {
  maxMessages: 300,
  maxUserMessageChars: 8000,
  maxToolMessageChars: 20_000,
  maxAttachments: 5,
  maxAttachmentBase64Chars: 2_800_000,
} as const;
