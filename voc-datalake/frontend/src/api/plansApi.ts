/**
 * @fileoverview Assistant plans (docs/assistant-plan-mode.md → "API"): lenient
 * read normalizers for a plan's progress view and the REST calls under the
 * Agents API (`/agents/plans*`, `agents_handler.py`).
 *
 * Any signed-in user approves their own plan; the approver (and admins) read and
 * cancel it, and only the approver resolves a step that needs approval. The
 * server never returns the approver's sub or email.
 *
 * @module api/plansApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { isObject as isRecord } from './workflowsApi'
import { lenientList } from '../assistant/lenient'
import { TOOL_PACKS } from '../assistant/contract'
import { PLAN_STATUSES, PLAN_STEP_KINDS, PLAN_STEP_STATUSES } from '../assistant/plan/schema'
import type { VocPlan } from '../assistant/plan/schema'

export type PlanStatus = (typeof PLAN_STATUSES)[number]
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]

/** A plan in one of these will not change again: polling stops. */
const TERMINAL_PLAN_STATUSES: readonly PlanStatus[] = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'expired']

export const isTerminalPlan = (status: PlanStatus): boolean => TERMINAL_PLAN_STATUSES.includes(status)

const optionalString = z.string().optional().catch(undefined)
const recordObject = z.record(z.string(), z.unknown())

/** sha256 hex of the paused write; the approve call sends it back so it approves exactly what was shown. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/

const PendingSchema = z.object({
  tool: z.string().min(1),
  args: recordObject.catch({}),
  reason: z.string().catch(''),
  // '' when absent or malformed: the step can then only be declined (the server would refuse the approve).
  fingerprint: z.string().regex(FINGERPRINT_RE).catch(''),
})
export type PlanPending = z.output<typeof PendingSchema>

/** Output values are strings on the wire (ids ≤ 500 characters, an analysis result ≤ 8,000); anything else is dropped. */
const outputsSchema = z.record(z.string(), z.unknown()).catch({}).transform((raw) =>
  Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : []))))

const PlanStepViewSchema = z.object({
  id: z.string().min(1),
  title: z.string().catch(''),
  pack: z.enum(TOOL_PACKS).catch('core'),
  kind: z.enum(PLAN_STEP_KINDS).catch('write'),
  after: z.array(z.string()).catch([]),
  status: z.enum(PLAN_STEP_STATUSES).catch('pending'),
  started_at: optionalString,
  finished_at: optionalString,
  outputs: outputsSchema,
  error: optionalString,
  pending: PendingSchema.optional().catch(undefined),
})
export type PlanStepView = z.output<typeof PlanStepViewSchema>

/** The fields a plan's list entry and its full view share. */
const PLAN_HEADER = {
  plan_id: z.string().min(1),
  status: z.enum(PLAN_STATUSES).catch('failed'),
  goal: z.string().catch(''),
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
}

const PlanViewSchema = z.object({
  ...PLAN_HEADER,
  started_at: optionalString,
  finished_at: optionalString,
  conversation_id: optionalString,
  steps: z.unknown().transform((raw) => lenientList(PlanStepViewSchema, raw)),
  summary: optionalString,
})
export type PlanView = z.output<typeof PlanViewSchema>

const PlanSummarySchema = z.object(PLAN_HEADER)
export type PlanSummary = z.output<typeof PlanSummarySchema>

const CreatedSchema = z.object({ plan_id: z.string().min(1), status: z.string().catch('approved') })

/** `{plan: {...}}` → the plan view, or null when unreadable. */
export function normalizePlanView(raw: unknown): PlanView | null {
  const parsed = PlanViewSchema.safeParse(isRecord(raw) && isRecord(raw.plan) ? raw.plan : raw)
  return parsed.success ? parsed.data : null
}

function normalizePlanList(raw: unknown): PlanSummary[] {
  return lenientList(PlanSummarySchema, isRecord(raw) ? raw.plans : undefined)
}

function requirePlan(raw: unknown): PlanView {
  const plan = normalizePlanView(raw)
  if (plan === null) throw new Error('The plan answer was unreadable')
  return plan
}

function requireCreated(raw: unknown): { plan_id: string; status: string } {
  const parsed = CreatedSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The plan answer was unreadable')
  return parsed.data
}

export const plansKeys = {
  all: () => ['agents', 'plans'] as const,
  list: () => ['agents', 'plans', 'list'] as const,
  detail: (planId: string) => ['agents', 'plans', 'detail', planId] as const,
}

/** How many plans the Agents page lists. */
const PLAN_LIST_LIMIT = 20

const planPath = (planId: string, suffix = '') => `/agents/plans/${encodeURIComponent(planId)}${suffix}`
const stepPath = (planId: string, stepId: string, action: 'approve' | 'decline') =>
  planPath(planId, `/steps/${encodeURIComponent(stepId)}/${action}`)
const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

export const plansApi = {
  /** Approve and start a plan; the caller is the approver. 400 lists the plan's errors. */
  create: async (plan: VocPlan, conversationId?: string) => requireCreated(await fetchApi<unknown>(
    '/agents/plans',
    post(conversationId === undefined || conversationId === '' ? { plan } : { plan, conversation_id: conversationId }),
  )),
  get: async (planId: string): Promise<PlanView> => requirePlan(await fetchApi<unknown>(planPath(planId))),
  list: async (limit = PLAN_LIST_LIMIT): Promise<PlanSummary[]> =>
    normalizePlanList(await fetchApi<unknown>(`/agents/plans?limit=${limit}`)),
  cancel: async (planId: string): Promise<PlanView> => requirePlan(await fetchApi<unknown>(planPath(planId, '/cancel'), post())),
  /** Take a finished plan off the caller's list (it is kept, never deleted); 409 while it is still active. */
  remove: async (planId: string): Promise<PlanView> => requirePlan(await fetchApi<unknown>(planPath(planId), { method: 'DELETE' })),
  /** Approve the paused write the caller reviewed (`fingerprint` of the `pending` shown); 409 when it changed since. */
  approveStep: async (planId: string, stepId: string, fingerprint: string): Promise<PlanView> =>
    requirePlan(await fetchApi<unknown>(stepPath(planId, stepId, 'approve'), post({ fingerprint }))),
  declineStep: async (planId: string, stepId: string): Promise<PlanView> =>
    requirePlan(await fetchApi<unknown>(stepPath(planId, stepId, 'decline'), post())),
}
