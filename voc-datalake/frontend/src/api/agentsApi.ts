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
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientList } from './lenientFields'
import { isObject, schemaGuard as guard } from './workflowsApi'

export const AGENT_SCHEDULE_EVERY = ['12h', '24h', 'cron'] as const
export const AGENT_THRESHOLD_PER = ['category', 'subcategory'] as const
export const AGENT_VISIBILITIES = ['private', 'public'] as const
export const AGENT_MODEL_ROLES = ['orchestrator', 'worker', 'reviewer', 'persona'] as const
export const TRIGGER_KINDS = ['new_reviews', 'schedule', 'threshold'] as const

const RUN_STATUSES = ['queued', 'running', 'needs_human', 'completed', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running']
const RUN_TRIGGERS = ['manual', 'schedule', 'new_reviews', 'threshold'] as const
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
  maxCronChars: 100,
  maxTimezoneChars: 64,
  maxModelIdChars: 128,
  maxScheduledRunsPerDay: 2,
  minModelCallsPerRun: 10,
  maxModelCallsPerRun: 500,
  maxMonthlyCallCap: 1_000_000,
  monthlyCapNullable: true,
}

/** Every configurable agent field, strict, for the given limits and id rule. */
export function buildAgentFieldsShape(limits: AgentLimits, idSchema: z.ZodType<string>) {
  const categoryName = z.string().trim().min(1).max(limits.maxCategoryNameChars)
  const scope = z.strictObject({
    all: z.boolean(),
    categories: z.array(categoryName).max(limits.maxCategories),
    subcategories: z.array(z.strictObject({ category: categoryName, name: categoryName })).max(limits.maxSubcategories),
  }).refine(
    (s) => s.all || s.categories.length > 0 || s.subcategories.length > 0,
    'scope needs all=true or at least one category or subcategory',
  )
  const trigger = z.discriminatedUnion('kind', [
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
  ]).refine(
    (t) => t.kind !== 'schedule' || (t.every === 'cron') === (t.cron !== undefined),
    'a schedule needs cron exactly when every is "cron"',
  )
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

const formIdSchema = z.string().trim().min(1).max(128).regex(/^[\w.:-]+$/, 'Invalid identifier')

/** The agent form's body (create/update): every field, API limits. */
export const agentFormSchema = z.strictObject(buildAgentFieldsShape(API_AGENT_LIMITS, formIdSchema))
export type AgentForm = z.output<typeof agentFormSchema>
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
])

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
  scope: z.object({
    all: z.boolean().catch(false),
    categories: lenientList((c): c is string => typeof c === 'string'),
    subcategories: lenientList(guard(z.object({ category: z.string(), name: z.string() }))),
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
})
export type AgentRun = z.output<typeof RunSchema>

const RunEventSchema = z.object({
  seq: z.number().int(),
  at: z.string().catch(''),
  kind: z.enum(RUN_EVENT_KINDS),
  node_id: z.string().optional().catch(undefined),
  role: z.string().optional().catch(undefined),
  summary: z.string().catch(''),
  ref: RefSchema.optional().catch(undefined),
})
export type RunEvent = z.output<typeof RunEventSchema>

/** `{key: {...}}` or the bare record. */
function unwrap(raw: unknown, key: string): unknown {
  return isObject(raw) && isObject(raw[key]) ? raw[key] : raw
}

export function normalizeAgent(raw: unknown): Agent | null {
  const parsed = AgentSchema.safeParse(unwrap(raw, 'agent'))
  return parsed.success ? parsed.data : null
}

function normalizeAgentList(raw: unknown): Agent[] {
  const items: unknown[] = isObject(raw) && Array.isArray(raw.items) ? raw.items : []
  return items.flatMap((item) => {
    const agent = normalizeAgent(item)
    return agent === null ? [] : [agent]
  })
}

function normalizeRun(raw: unknown): AgentRun | null {
  const parsed = RunSchema.safeParse(unwrap(raw, 'run'))
  return parsed.success ? parsed.data : null
}

function normalizeRunPage(raw: unknown): { items: AgentRun[]; nextCursor: string | null } {
  const items = isObject(raw) && Array.isArray(raw.items) ? raw.items : []
  const runs = items.flatMap((item) => {
    const run = normalizeRun(item)
    return run === null ? [] : [run]
  })
  const next = isObject(raw) && typeof raw.next_cursor === 'string' && raw.next_cursor !== '' ? raw.next_cursor : null
  return { items: runs, nextCursor: next }
}

function normalizeEventPage(raw: unknown, after: number): { items: RunEvent[]; nextAfter: number } {
  const items = lenientList(guard(RunEventSchema)).parse(isObject(raw) ? raw.items : undefined)
  const next = isObject(raw) && typeof raw.next_after === 'number' ? raw.next_after : (items.at(-1)?.seq ?? after)
  return { items, nextAfter: next }
}

export const isActiveRun = (run: Pick<AgentRun, 'status'>) => ACTIVE_RUN_STATUSES.includes(run.status)

// ── REST ─────────────────────────────────────────────────────────────────────

export const agentsKeys = {
  all: () => ['agents'] as const,
  list: () => ['agents', 'list'] as const,
  detail: (id: string) => ['agents', 'detail', id] as const,
  runs: (id: string) => ['agents', 'runs', id] as const,
  run: (id: string, runId: string) => ['agents', 'run', id, runId] as const,
}

const agentPath = (id: string, suffix = '') => `/agents/${encodeURIComponent(id)}${suffix}`
const runPath = (id: string, runId: string, suffix = '') => agentPath(id, `/runs/${encodeURIComponent(runId)}${suffix}`)
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

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
  get: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentPath(id))),
  create: async (fields: Partial<AgentForm>): Promise<Agent> => requireAgent(await fetchApi<unknown>('/agents', post(fields))),
  update: async (id: string, fields: Partial<AgentForm>): Promise<Agent> =>
    requireAgent(await fetchApi<unknown>(agentPath(id), { method: 'PUT', body: JSON.stringify(fields) })),
  /** Archive (never delete): disabled and hidden, runs kept. */
  archive: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentPath(id), { method: 'DELETE' })),
  enable: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentPath(id, '/enable'), post())),
  disable: async (id: string): Promise<Agent> => requireAgent(await fetchApi<unknown>(agentPath(id, '/disable'), post())),
  /** "Run now" — 409 while a run is active. */
  run: async (id: string): Promise<AgentRun> => requireRun(await fetchApi<unknown>(agentPath(id, '/run'), post())),
  listRuns: async (id: string, cursor?: string) => {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
    return normalizeRunPage(await fetchApi<unknown>(agentPath(id, `/runs${query}`)))
  },
  getRun: async (id: string, runId: string): Promise<AgentRun> => requireRun(await fetchApi<unknown>(runPath(id, runId))),
  listEvents: async (id: string, runId: string, after: number) =>
    normalizeEventPage(await fetchApi<unknown>(runPath(id, runId, `/events?after=${after}`)), after),
  cancelRun: async (id: string, runId: string): Promise<AgentRun> =>
    requireRun(await fetchApi<unknown>(runPath(id, runId, '/cancel'), post())),
}
