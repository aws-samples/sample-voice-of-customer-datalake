/**
 * @fileoverview Autonomous agents: configuration model (Zod), lenient read
 * normalizers for agents / runs / run events, and the REST calls
 * (`/agents/*`, `agents_handler.py`).
 *
 * The configurable fields are BUILT from a limits object, like the workflow
 * definition (`workflowsApi.ts`): {@link API_AGENT_LIMITS} mirrors
 * `lambda/shared/agents_store.py` and drives the agent form; the assistant
 * approval boundary builds the same shape with the stream Lambda's limits.
 *
 * @module api/agentsApi
 */
import { del, post, put } from './requestKit'
import { z } from 'zod'
import { AGENT_SCHEDULE_EVERY, AGENT_THRESHOLD_PER, AGENT_VISIBILITIES } from '@stream/assistant/tools/agent-limits'
import { fetchApi } from './client'
import { nextAfterOf } from './seqPages'
import { lenientList } from './lenientFields'
import { optionalMethodologyBlock } from './methodologySchema'
import { NeedsHumanSchema, RunActionsSchema, RunDecisionSchema } from './agentRunDecision'
import { isRecord } from '../lib/typeGuards'
import { schemaGuard as guard } from './workflowsApi'
import type { RunDecisionKind } from './agentRunDecision'

export const TRIGGER_KINDS = ['new_reviews', 'schedule', 'threshold'] as const
/** An engineering agent's triggers (7.47.00): a labelled GitHub issue too. */
export const ENGINEERING_TRIGGER_KINDS = ['github_issue', ...TRIGGER_KINDS] as const
/** What an engineering agent works on (`engineering.feedback_type`). */
const ENGINEERING_FEEDBACK_TYPES = ['bug', 'feature_request'] as const

const RUN_STATUSES = ['queued', 'running', 'needs_human', 'completed', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running']
const RUN_TRIGGERS = ['manual', 'schedule', 'new_reviews', 'threshold', 'github_issue'] as const
const RUN_EVENT_KINDS = [
  'node_started', 'node_finished', 'node_failed', 'message', 'verdict', 'decision', 'artifact',
] as const

export interface AgentLimits {
  maxNameChars: number
  maxDescriptionChars: number
  maxInstructionsChars: number
  maxCategories: number
  maxSubcategories: number
  maxCategoryNameChars: number
  maxFixedPersonas: number
  maxTriggers: number
  maxCooldownHours: number
  maxMinNew: number
  maxThresholdCount: number
  maxWindowDays: number
  maxCronChars: number
  maxTimezoneChars: number
  maxModelIdChars: number
  maxScheduledRunsPerDay: number
  minModelCallsPerRun: number
  maxModelCallsPerRun: number
  maxMonthlyCallCap: number
  /** The API accepts `monthly_call_cap: null` = explicitly uncapped. */
  monthlyCapNullable: boolean
}

/** `lambda/shared/agents_store.py` — pinned by agentsApi.lockstep.test.ts. */
export const API_AGENT_LIMITS: AgentLimits = {
  maxNameChars: 80,
  maxDescriptionChars: 2000,
  maxInstructionsChars: 8000,
  maxCategories: 50,
  maxSubcategories: 50,
  maxCategoryNameChars: 64,
  maxFixedPersonas: 6,
  maxTriggers: 5,
  maxCooldownHours: 168,
  maxMinNew: 10_000,
  maxThresholdCount: 100_000,
  maxWindowDays: 90,
  maxCronChars: 120,
  maxTimezoneChars: 64,
  maxModelIdChars: 128,
  maxScheduledRunsPerDay: 2,
  minModelCallsPerRun: 10,
  maxModelCallsPerRun: 500,
  maxMonthlyCallCap: 1_000_000,
  monthlyCapNullable: true,
}

/**
 * An engineering agent's own bounds (7.47.00), `lambda/shared/agents_store.py` (pinned by agentsApi.lockstep.test.ts):
 * its instructions become the trusted start of its run's goal, its runs per day, its `github_issue` trigger's label
 * and look-back, and the `source_platform` ids a scope may name (any agent's).
 */
export const API_ENGINEERING_LIMITS = {
  maxInstructionsChars: 300,
  maxRunsPerDay: 5,
  defaultRunsPerDay: 1,
  maxIssueLabelChars: 50,
  defaultIssueLabel: 'voc-agent',
  maxLookbackDays: 30,
  defaultLookbackDays: 7,
  maxScopeSources: 20,
} as const

const SCOPE_RULE = 'scope needs all=true or at least one category or subcategory'
const CRON_RULE = 'a schedule needs cron exactly when every is "cron"'
const scopeNamesSome = (s: { all: boolean; categories: unknown[]; subcategories: unknown[] }): boolean =>
  s.all || s.categories.length > 0 || s.subcategories.length > 0

/** A scope's own fields (all, categories, subcategories), before its rule. */
function scopeObject(limits: AgentLimits) {
  const categoryName = z.string().trim().min(1).max(limits.maxCategoryNameChars)
  return z.strictObject({
    all: z.boolean(),
    categories: z.array(categoryName).max(limits.maxCategories),
    subcategories: z.array(z.strictObject({ category: categoryName, name: categoryName })).max(limits.maxSubcategories),
  })
}

/** The triggers every agent may have: new reviews, a schedule, a threshold. */
function triggerVariants(limits: AgentLimits) {
  return [
    z.strictObject({
      kind: z.literal('new_reviews'),
      min_new: z.number().int().min(1).max(limits.maxMinNew),
      cooldown_hours: z.number().int().min(0).max(limits.maxCooldownHours),
    }),
    z.strictObject({
      kind: z.literal('schedule'),
      every: z.enum(AGENT_SCHEDULE_EVERY),
      cron: z.string().trim().min(1).max(limits.maxCronChars).optional(),
      timezone: z.string().trim().min(1).max(limits.maxTimezoneChars),
    }),
    z.strictObject({
      kind: z.literal('threshold'),
      count: z.number().int().min(1).max(limits.maxThresholdCount),
      per: z.enum(AGENT_THRESHOLD_PER),
      window_days: z.number().int().min(1).max(limits.maxWindowDays),
    }),
  ] as const
}

/** Every configurable agent field, strict, for the given limits and id rule (the assistant's approval cards' too). */
export function buildAgentFieldsShape(limits: AgentLimits, idSchema: z.ZodType<string>) {
  const scope = scopeObject(limits).refine(scopeNamesSome, SCOPE_RULE)
  const trigger = z.discriminatedUnion('kind', triggerVariants(limits)).refine(
    (t) => t.kind !== 'schedule' || (t.every === 'cron') === (t.cron !== undefined), CRON_RULE)
  const modelOverride = z.string().trim().min(1).max(limits.maxModelIdChars).nullable().optional()
  const monthlyCap = z.number().int().min(0).max(limits.maxMonthlyCallCap)
  return {
    name: z.string().trim().min(1).max(limits.maxNameChars),
    description: z.string().max(limits.maxDescriptionChars),
    scope,
    instructions: z.string().max(limits.maxInstructionsChars),
    personas: z.strictObject({
      fixed: z.array(z.strictObject({ project_id: idSchema, persona_id: idSchema })).max(limits.maxFixedPersonas),
      allow_generate: z.boolean(),
    }),
    triggers: z.array(trigger).max(limits.maxTriggers),
    models: z.strictObject({
      orchestrator: modelOverride, worker: modelOverride, reviewer: modelOverride, persona: modelOverride,
    }),
    output: z.strictObject({ visibility: z.enum(AGENT_VISIBILITIES) }),
    workflow_id: idSchema,
    budget: z.strictObject({
      max_scheduled_runs_per_day: z.number().int().min(0).max(limits.maxScheduledRunsPerDay),
      max_model_calls_per_run: z.number().int().min(limits.minModelCallsPerRun).max(limits.maxModelCallsPerRun),
      monthly_call_cap: limits.monthlyCapNullable ? monthlyCap.nullable() : monthlyCap,
    }).partial(),
  }
}

// ── The agent form's own fields (7.47.00): never the assistant's (its agent tools have no engineering fields) ──

const sourceId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid source id')

/** A scope with `sources`: the `source_platform` ids the agent's reviews come from (none: every source). */
function formScope(limits: AgentLimits) {
  return scopeObject(limits).extend({ sources: z.array(sourceId).max(API_ENGINEERING_LIMITS.maxScopeSources).optional() })
    .refine(scopeNamesSome, SCOPE_RULE)
}

/** An engineering agent's triggers: a labelled GitHub issue of its repository too. */
function engineeringTriggers(limits: AgentLimits) {
  const issue = z.strictObject({
    kind: z.literal('github_issue'),
    label: z.string().trim().max(API_ENGINEERING_LIMITS.maxIssueLabelChars),
    trusted_authors: z.boolean(),
    lookback_days: z.number().int().min(1).max(API_ENGINEERING_LIMITS.maxLookbackDays),
  })
  const trigger = z.discriminatedUnion('kind', [...triggerVariants(limits), issue]).refine(
    (t) => t.kind !== 'schedule' || (t.every === 'cron') === (t.cron !== undefined), CRON_RULE)
  return z.array(trigger).max(limits.maxTriggers)
}

const formIdSchema = z.string().trim().min(1).max(128).regex(/^[\w.:-]+$/, 'Invalid identifier')
const ENGINEERING_FORM_LIMITS: AgentLimits = {
  ...API_AGENT_LIMITS, maxInstructionsChars: API_ENGINEERING_LIMITS.maxInstructionsChars,
  maxScheduledRunsPerDay: API_ENGINEERING_LIMITS.maxRunsPerDay,
}

/** The agent form's body (create/update) for an agent that runs an agents workflow: every field, API limits. */
export const agentFormSchema = z.strictObject({
  ...buildAgentFieldsShape(API_AGENT_LIMITS, formIdSchema), scope: formScope(API_AGENT_LIMITS),
})
/** An engineering agent's: its own instructions and runs-per-day bounds, its `github_issue` trigger, its
 *  `engineering` settings (connection and language null until it is set up). */
export const engineeringAgentFormSchema = z.strictObject({
  ...buildAgentFieldsShape(ENGINEERING_FORM_LIMITS, formIdSchema),
  scope: formScope(ENGINEERING_FORM_LIMITS),
  triggers: engineeringTriggers(ENGINEERING_FORM_LIMITS),
  engineering: z.strictObject({
    connection: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Invalid connection id').nullable(),
    language: z.string().trim().min(1).max(32).nullable(),
    feedback_type: z.enum(ENGINEERING_FEEDBACK_TYPES),
  }),
})
export type AgentForm = z.output<typeof engineeringAgentFormSchema>
export type AgentTrigger = AgentForm['triggers'][number]
export type AgentScope = AgentForm['scope']

// ── Lenient reads ────────────────────────────────────────────────────────────

const nullableString = z.string().nullable().catch(null)
const count = z.number().int().nonnegative().catch(0)

const LenientTriggerSchema = z.union([
  z.object({ kind: z.literal('new_reviews'), min_new: z.number().int(), cooldown_hours: z.number().int() }),
  z.object({
    kind: z.literal('schedule'),
    every: z.enum(AGENT_SCHEDULE_EVERY),
    cron: z.string().optional().catch(undefined),
    timezone: z.string().catch('UTC'),
  }),
  z.object({
    kind: z.literal('threshold'), count: z.number().int(), per: z.enum(AGENT_THRESHOLD_PER), window_days: z.number().int(),
  }),
  z.object({
    kind: z.literal('github_issue'),
    label: z.string().catch(API_ENGINEERING_LIMITS.defaultIssueLabel),
    trusted_authors: z.boolean().catch(false),
    lookback_days: z.number().int().catch(API_ENGINEERING_LIMITS.defaultLookbackDays),
  }),
])

/** An engineering agent's settings (7.47.00): null for an agent that runs an agents workflow. */
const EngineeringSchema = z.object({
  connection: z.string().nullable().catch(null),
  language: z.string().nullable().catch(null),
  feedback_type: z.enum(ENGINEERING_FEEDBACK_TYPES).catch('bug'),
}).nullable().catch(null)

const StatsSchema = z.object({
  runs_total: count,
  runs_completed: count,
  runs_failed: count,
  runs_cancelled: count,
  runs_needs_human: count,
  last_run_at: nullableString,
  last_run_id: nullableString,
  last_run_status: z.enum(RUN_STATUSES).nullable().catch(null),
  active_run_id: nullableString,
  scheduled_runs_today: count,
  model_calls_this_month: count,
  last_skip_reason: nullableString,
})
const EMPTY_STATS: z.output<typeof StatsSchema> = StatsSchema.parse({})

const modelId = z.string().nullable().optional().catch(null).transform((v) => v ?? null)

const AgentSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().catch(''),
  description: z.string().catch(''),
  enabled: z.boolean().catch(false),
  status: z.enum(['active', 'archived']).catch('active'),
  owner_sub: nullableString,
  /** Who an engineering agent runs as: the administrator who enabled it. */
  owner_username: nullableString,
  scope: z.object({
    all: z.boolean().catch(false),
    categories: lenientList((c): c is string => typeof c === 'string'),
    subcategories: lenientList(guard(z.object({ category: z.string(), name: z.string() }))),
    /** The `source_platform` ids the agent's reviews come from; left out for every source. */
    sources: z.array(z.string()).optional().catch(undefined),
  }).catch({ all: true, categories: [], subcategories: [] }),
  instructions: z.string().catch(''),
  personas: z.object({
    fixed: lenientList(guard(z.object({ project_id: z.string(), persona_id: z.string() }))),
    allow_generate: z.boolean().catch(true),
  }).catch({ fixed: [], allow_generate: true }),
  triggers: lenientList(guard(LenientTriggerSchema)),
  models: z.object({ orchestrator: modelId, worker: modelId, reviewer: modelId, persona: modelId })
    .catch({ orchestrator: null, worker: null, reviewer: null, persona: null }),
  output: z.object({ visibility: z.enum(AGENT_VISIBILITIES).catch('private') }).catch({ visibility: 'private' }),
  workflow_id: nullableString,
  budget: z.object({
    max_scheduled_runs_per_day: z.number().int().catch(2),
    max_model_calls_per_run: z.number().int().catch(150),
    monthly_call_cap: z.number().int().nullable().catch(5000),
  }).catch({ max_scheduled_runs_per_day: 2, max_model_calls_per_run: 150, monthly_call_cap: 5000 }),
  engineering: EngineeringSchema,
  created_by: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
  stats: StatsSchema.catch(EMPTY_STATS),
})
export type Agent = z.output<typeof AgentSchema>

const RefSchema = z.object({
  project_id: z.string().optional().catch(undefined),
  document_id: z.string().optional().catch(undefined),
  persona_id: z.string().optional().catch(undefined),
  job_id: z.string().optional().catch(undefined),
})

const RunSchema = z.object({
  run_id: z.string().min(1),
  agent_id: z.string().catch(''),
  status: z.enum(RUN_STATUSES).catch('failed'),
  trigger: z.enum(RUN_TRIGGERS).catch('manual'),
  started_at: nullableString,
  finished_at: nullableString,
  project_id: nullableString,
  current_node_id: nullableString,
  model_calls: count,
  error: nullableString,
  workflow_id: nullableString,
  workflow_revision: z.number().int().nullable().catch(null),
  /** An engineering agent's run (7.47.00): its engineering run (the run monitor's) and what it started from. */
  kind: z.literal('engineering').nullable().catch(null),
  engineering_run_id: nullableString,
  issue: z.object({ repository: z.string(), number: z.number().int() }).nullable().catch(null),
  prd: z.object({ project_id: z.string(), document_id: z.string() }).nullable().catch(null),
  feedback_count: z.number().int().nullable().catch(null),
  needs_human: NeedsHumanSchema,
  decision: RunDecisionSchema,
  actions: RunActionsSchema,
})
export type AgentRun = z.output<typeof RunSchema>

const RunEventSchema = z.object({
  seq: z.number().int(),
  at: z.string().catch(''),
  kind: z.enum(RUN_EVENT_KINDS),
  node_id: z.string().optional().catch(undefined),
  role: z.string().optional().catch(undefined),
  summary: z.string().catch(''),
  /** A failed step's technical reason (masked, one line) beside the plain `summary`: "Show technical log" only. */
  detail: z.string().optional().catch(undefined),
  ref: RefSchema.optional().catch(undefined),
  /** The block a methodology step's route or job answered (skipped steps, warnings): api/methodologySchema.ts. */
  methodology: optionalMethodologyBlock.optional(),
})
export type RunEvent = z.output<typeof RunEventSchema>

/** `{key: {...}}` or the bare record. */
function unwrap(raw: unknown, key: string): unknown {
  return isRecord(raw) && isRecord(raw[key]) ? raw[key] : raw
}

export function normalizeAgent(raw: unknown): Agent | null {
  const parsed = AgentSchema.safeParse(unwrap(raw, 'agent'))
  return parsed.success ? parsed.data : null
}

function normalizeAgentList(raw: unknown): Agent[] {
  const items: unknown[] = isRecord(raw) && Array.isArray(raw.items) ? raw.items : []
  return items.flatMap((item) => {
    const agent = normalizeAgent(item)
    return agent === null ? [] : [agent]
  })
}

function normalizeRun(raw: unknown): AgentRun | null {
  const parsed = RunSchema.safeParse(unwrap(raw, 'run'))
  return parsed.success ? parsed.data : null
}

function normalizeRunPage(raw: unknown): { items: AgentRun[] } {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : []
  const runs = items.flatMap((item) => {
    const run = normalizeRun(item)
    return run === null ? [] : [run]
  })
  return { items: runs }
}

function normalizeEventPage(raw: unknown, after: number): { items: RunEvent[]; nextAfter: number } {
  const items = lenientList(guard(RunEventSchema)).parse(isRecord(raw) ? raw.items : undefined)
  return { items, nextAfter: nextAfterOf(raw, items, after) }
}

export const isActiveRun = (run: Pick<AgentRun, 'status'>) => ACTIVE_RUN_STATUSES.includes(run.status)

/** An agent that runs an engineering flow (its `engineering` settings, 7.47.00). */
export const isEngineeringAgent = (agent: Pick<Agent, 'engineering'>): boolean => agent.engineering !== null

/** What an engineering agent's Run now starts from: an issue of its repository, or a project's PRD (a feature agent). */
export type RunNowBody = { issue: number } | { prd: { project_id: string; document_id: string } }

// ── REST ─────────────────────────────────────────────────────────────────────

export const agentsKeys = {
  list: () => ['agents', 'list'] as const,
  detail: (id: string) => ['agents', 'detail', id] as const,
  runs: (id: string) => ['agents', 'runs', id] as const,
  run: (id: string, runId: string) => ['agents', 'run', id, runId] as const,
}

const agentApiPath = (id: string, suffix = '') => `/agents/${encodeURIComponent(id)}${suffix}`
const runPath = (id: string, runId: string, suffix = '') => agentApiPath(id, `/runs/${encodeURIComponent(runId)}${suffix}`)

function requireAgent(raw: unknown): Agent {
  const agent = normalizeAgent(raw)
  if (agent === null) throw new Error('The agent answer was unreadable')
  return agent
}

function requireRun(raw: unknown): AgentRun {
  const run = normalizeRun(raw)
  if (run === null) throw new Error('The run answer was unreadable')
  return run
}

export const agentsApi = {
  list: async (): Promise<Agent[]> => normalizeAgentList(await fetchApi<unknown>('/agents')),
  get: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentApiPath(id))),
  create: async (fields: Partial<AgentForm>): Promise<Agent> => requireAgent(await fetchApi<unknown>('/agents', post(fields))),
  update: async (id: string, fields: Partial<AgentForm>): Promise<Agent> =>
    requireAgent(await fetchApi<unknown>(agentApiPath(id), put(fields))),
  /** Archive (never delete): disabled and hidden, runs kept. */
  archive: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentApiPath(id), del())),
  enable: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentApiPath(id, '/enable'), post())),
  disable: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentApiPath(id, '/disable'), post())),
  /** "Run now" — 409 while a run is active; an engineering agent's may start from an issue or a PRD (`body`). */
  run: async (id: string, body?: RunNowBody): Promise<AgentRun> =>
    requireRun(await fetchApi<unknown>(agentApiPath(id, '/run'), post(body))),
  listRuns: async (id: string, cursor?: string) => {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
    return normalizeRunPage(await fetchApi<unknown>(agentApiPath(id, `/runs${query}`)))
  },
  getRun: async (id: string, runId: string): Promise<AgentRun> => requireRun(await fetchApi<unknown>(runPath(id, runId))),
  listEvents: async (id: string, runId: string, after: number) =>
    normalizeEventPage(await fetchApi<unknown>(runPath(id, runId, `/events?after=${after}`)), after),
  cancelRun: async (id: string, runId: string): Promise<AgentRun> =>
    requireRun(await fetchApi<unknown>(runPath(id, runId, '/cancel'), post())),
  /** Decide a run that needs a person (admin): accept / another_round re-queue the same run, stop closes it. */
  decideRun: async (id: string, runId: string, decision: RunDecisionKind, note?: string): Promise<AgentRun> =>
    requireRun(await fetchApi<unknown>(runPath(id, runId, '/decision'), post({ decision, ...(note === undefined ? {} : { note }) }))),
}
