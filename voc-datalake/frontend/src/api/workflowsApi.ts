/**
 * @fileoverview The workflow library: the definition model (Zod) of both kinds,
 * an agents workflow (`voc-workflow/1`) and an engineering flow (`voc-workflow/2`),
 * the lenient read normalizers and the REST calls (`/workflows/*`, `agents_handler.py`).
 *
 * The definition schema is BUILT from a limits object so the two boundaries
 * that judge a definition share one shape:
 * - {@link API_WORKFLOW_LIMITS} mirrors `lambda/shared/workflow_schema.py` (the
 *   server that stores it) — the editor validates against it before saving;
 * - the assistant approval boundary builds the same schema with the stream
 *   Lambda's limits (`approvals/agentSchemas.ts`).
 * The API limits are pinned to the Python file by workflowsApi.lockstep.test.ts;
 * the stream limits and the node / role / edge / loop vocabulary are imported
 * from the stream's own `@stream/assistant/tools/agent-limits`.
 *
 * Graph rules (one start, reachable end, loops) are NOT in the schema: the
 * editor runs a client-side port of them (`components/WorkflowEditor/graphRules.ts`)
 * and the server's `POST /workflows/validate` stays the judge.
 *
 * @module api/workflowsApi
 */
import { del, post, put } from './requestKit'
import { z } from 'zod'
import {
  MONTHLY_BUDGET_RULE, WORKFLOW_ALL_NODE_TYPES, WORKFLOW_EDGE_LABELS, WORKFLOW_LOOP_UNTIL, WORKFLOW_NODE_ROLES,
  WORKFLOW_SCHEMA_V2, WORKFLOW_SCHEMA_VERSION, isMonthlyBudgetUsd,
} from '@stream/assistant/tools/agent-limits'
import { isRecord } from '../lib/typeGuards'
import { fetchApi } from './client'
import { lenientList } from './lenientFields'
import type { QueryClient } from '@tanstack/react-query'

export const DEFAULT_WORKFLOW_ID = 'wf_default'

const WORKFLOW_SCHEMAS = [WORKFLOW_SCHEMA_VERSION, WORKFLOW_SCHEMA_V2] as const

/** A step of either kind of workflow (an agents workflow's, or an engineering flow's). */
export type WorkflowNodeType = (typeof WORKFLOW_ALL_NODE_TYPES)[number]
/** `voc-workflow/1` (an agents workflow) or `voc-workflow/2` (an engineering flow). */
export type WorkflowSchema = (typeof WORKFLOW_SCHEMAS)[number]
export type WorkflowNodeRole = (typeof WORKFLOW_NODE_ROLES)[number]
export type WorkflowEdgeLabel = (typeof WORKFLOW_EDGE_LABELS)[number]

/** `persona_review` / `revise_document` params.target. */
export const REVIEW_TARGETS = ['prfaq', 'prd', 'prototype'] as const
/** `end` params.status. */
export const END_STATUSES = ['completed', 'needs_human'] as const

export interface WorkflowLimits {
  maxNodes: number
  maxEdges: number
  maxLoops: number
  minRounds: number
  maxRounds: number
  maxNameChars: number
  maxDescriptionChars: number
  maxTitleChars: number
  maxInstructionsChars: number
  maxParamsJsonChars: number
  maxDefinitionJsonChars: number
}

/** `lambda/shared/workflow_schema.py` (MAX_* constants) — pinned by workflowsApi.lockstep.test.ts. */
export const API_WORKFLOW_LIMITS: WorkflowLimits = {
  maxNodes: 60,
  maxEdges: 240,
  maxLoops: 10,
  minRounds: 1,
  maxRounds: 5,
  maxNameChars: 120,
  maxDescriptionChars: 2000,
  maxTitleChars: 120,
  maxInstructionsChars: 4000,
  maxParamsJsonChars: 4096,
  maxDefinitionJsonChars: 300_000,
}

/** The server's node/edge id charset (`_ID_RE` in workflow_schema.py). */
const WORKFLOW_ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/

const jsonLength = (value: unknown) => JSON.stringify(value).length

/**
 * A strict definition schema for the given limits and element-id rule, of the given kinds (both by default: the
 * editor's and the assistant's approval boundary's, whose create card adds the engineering module's check).
 */
export function buildWorkflowDefinitionSchema(
  limits: WorkflowLimits, elementId: z.ZodType<string>,
  schemas: readonly [WorkflowSchema, ...WorkflowSchema[]] = WORKFLOW_SCHEMAS,
) {
  const node = z.strictObject({
    id: elementId,
    type: z.enum(WORKFLOW_ALL_NODE_TYPES),
    position: z.strictObject({ x: z.number(), y: z.number() }),
    data: z.strictObject({
      title: z.string().trim().min(1).max(limits.maxTitleChars),
      instructions: z.string().max(limits.maxInstructionsChars).optional(),
      role: z.enum(WORKFLOW_NODE_ROLES).optional(),
      params: z.record(z.string(), z.unknown())
        .refine((params) => jsonLength(params) <= limits.maxParamsJsonChars, 'params are too large')
        .optional(),
    }),
  })
  const edge = z.strictObject({
    id: elementId,
    source: elementId,
    target: elementId,
    label: z.enum(WORKFLOW_EDGE_LABELS).optional(),
  })
  const loop = z.strictObject({
    node_ids: z.array(elementId).min(1).max(limits.maxNodes),
    until: z.enum(WORKFLOW_LOOP_UNTIL),
    max_rounds: z.number().int().min(limits.minRounds).max(limits.maxRounds),
  })
  return z.strictObject({
    schema: z.enum(schemas),
    name: z.string().trim().min(1).max(limits.maxNameChars),
    description: z.string().max(limits.maxDescriptionChars).optional(),
    nodes: z.array(node).min(1).max(limits.maxNodes),
    edges: z.array(edge).max(limits.maxEdges),
    loops: z.array(loop).max(limits.maxLoops),
    // An engineering flow's monthly budget (workflow_engineering.py budget_of): kept only when set.
    budget: z.strictObject({ monthly_usd: z.number().refine(isMonthlyBudgetUsd, MONTHLY_BUDGET_RULE) }).optional(),
  }).refine((definition) => jsonLength(definition) <= limits.maxDefinitionJsonChars, 'the definition is too large')
    .refine((definition) => definition.budget === undefined || definition.schema === WORKFLOW_SCHEMA_V2,
      { message: 'only an engineering flow has a budget', path: ['budget'] })
}

/** The editor's mirror of the server's definition shape. */
export const workflowDefinitionSchema = buildWorkflowDefinitionSchema(
  API_WORKFLOW_LIMITS,
  z.string().regex(WORKFLOW_ELEMENT_ID, 'must be 1-64 letters, digits, "_" or "-"'),
)

export type WorkflowDefinition = z.output<typeof workflowDefinitionSchema>
export type WorkflowNode = WorkflowDefinition['nodes'][number]
export type WorkflowEdge = WorkflowDefinition['edges'][number]
/** An engineering flow: it repeats through its board, so it has no loops, and its steps take no `data.role`. */
export const isEngineeringFlow = (definition: Pick<WorkflowDefinition, 'schema'>): boolean =>
  definition.schema === WORKFLOW_SCHEMA_V2
export type WorkflowLoop = WorkflowDefinition['loops'][number]

// ── Lenient reads ────────────────────────────────────────────────────────────

const optionalString = z.string().optional().catch(undefined)
const nullableString = z.string().nullable().catch(null)

const LenientNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(WORKFLOW_ALL_NODE_TYPES),
  position: z.object({ x: z.number().catch(0), y: z.number().catch(0) }).catch({ x: 0, y: 0 }),
  data: z.object({
    title: z.string().catch(''),
    instructions: optionalString,
    role: z.enum(WORKFLOW_NODE_ROLES).optional().catch(undefined),
    params: z.record(z.string(), z.unknown()).optional().catch(undefined),
  }).catch({ title: '', instructions: undefined, role: undefined, params: undefined }),
})
const LenientEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.enum(WORKFLOW_EDGE_LABELS).optional().catch(undefined),
})
const LenientLoopSchema = z.object({
  node_ids: z.array(z.string()).catch([]),
  until: z.enum(WORKFLOW_LOOP_UNTIL),
  max_rounds: z.number().int().catch(1),
})

/** A type guard from a schema, for {@link lenientList}. */
export const schemaGuard = <T>(schema: z.ZodType<T>) => (item: unknown): item is T => schema.safeParse(item).success
const guard = schemaGuard

/** One bad node / edge / loop costs itself, never the whole definition. */
const LenientDefinitionSchema = z.object({
  schema: z.enum(WORKFLOW_SCHEMAS).catch(WORKFLOW_SCHEMA_VERSION),
  name: z.string().catch(''),
  description: optionalString,
  nodes: lenientList(guard(LenientNodeSchema)),
  edges: lenientList(guard(LenientEdgeSchema)),
  loops: lenientList(guard(LenientLoopSchema)),
  // An engineering flow's monthly budget: kept, so a save from the editor never drops it (an unreadable one reads as
  // none, and the server refuses a save of one that breaks its rule).
  budget: z.object({ monthly_usd: z.number() }).optional().catch(undefined),
})

/** A stored/exported definition as the editor's model (unknown keys dropped), or null. */
export function normalizeDefinition(raw: unknown): WorkflowDefinition | null {
  const parsed = LenientDefinitionSchema.safeParse(raw)
  if (!parsed.success) return null
  const d = parsed.data
  return {
    schema: d.schema,
    name: d.name,
    ...(d.description === undefined ? {} : { description: d.description }),
    nodes: d.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.position.x, y: n.position.y },
      data: {
        title: n.data.title,
        ...(n.data.instructions === undefined ? {} : { instructions: n.data.instructions }),
        ...(n.data.role === undefined ? {} : { role: n.data.role }),
        ...(n.data.params === undefined ? {} : { params: n.data.params }),
      },
    })),
    edges: d.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, ...(e.label === undefined ? {} : { label: e.label }),
    })),
    loops: d.loops.map((l) => ({ node_ids: l.node_ids, until: l.until, max_rounds: l.max_rounds })),
    // (an agents workflow has none: one on an imported file would be an error the editor has no field to clear)
    ...(d.budget === undefined || d.schema !== WORKFLOW_SCHEMA_V2 ? {} : { budget: { monthly_usd: d.budget.monthly_usd } }),
  }
}

const WorkflowSummarySchema = z.object({
  workflow_id: z.string().min(1),
  slug: z.string().catch(''),
  name: z.string().catch(''),
  description: z.string().catch(''),
  revision: z.number().int().catch(1),
  derived_from: nullableString,
  builtin: z.boolean().catch(false),
  updated_at: nullableString,
  updated_by_username: nullableString,
  status: z.enum(['active', 'archived']).catch('active'),
  /** An agents workflow (the agents run it) or an engineering flow (`voc-workflow/2`, never an agent's). */
  kind: z.enum(['agents', 'engineering']).catch('agents'),
})
export type WorkflowSummary = z.output<typeof WorkflowSummarySchema>

export interface WorkflowView extends WorkflowSummary {
  definition: WorkflowDefinition | null
}

const RevisionSchema = z.object({
  revision: z.number().int(),
  saved_at: nullableString,
  saved_by_username: nullableString,
})
export type WorkflowRevision = z.output<typeof RevisionSchema>

/** `GET /workflows/{id}/revisions/{revision}`: one saved revision with its definition. */
const RevisionDetailSchema = RevisionSchema.extend({
  workflow_id: z.string().min(1),
  name: z.string().catch(''),
  definition: z.unknown().transform(normalizeDefinition),
})
export type WorkflowRevisionDetail = z.output<typeof RevisionDetailSchema>

/** The revision answer, or a thrown error when it does not parse (the history shows it as unreadable). */
function normalizeRevisionDetail(raw: unknown): WorkflowRevisionDetail {
  const parsed = RevisionDetailSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The workflow revision answer was unreadable')
  return parsed.data
}

const ValidationIssueSchema = z.object({ message: z.string(), node_id: optionalString })
export type WorkflowIssue = z.output<typeof ValidationIssueSchema>

/** A methodology gap of a valid workflow (lambda/shared/workflow_methodology.py): advice, never an error. */
const MethodologyWarningSchema = z.object({ code: z.string().min(1), message: z.string(), node_id: optionalString })
export type WorkflowMethodologyWarning = z.output<typeof MethodologyWarningSchema>

const ValidationResultSchema = z.object({
  valid: z.boolean().catch(false),
  errors: lenientList(guard(ValidationIssueSchema)),
  // Absent from an older API: no warnings.
  warnings: lenientList(guard(MethodologyWarningSchema)),
})
export type WorkflowValidation = z.output<typeof ValidationResultSchema>

/** `{workflow: {...}}` (or a bare view) → view; null when it does not parse. */
function normalizeWorkflowView(raw: unknown): WorkflowView | null {
  const body = isRecord(raw) && isRecord(raw.workflow) ? raw.workflow : raw
  const summary = WorkflowSummarySchema.safeParse(body)
  if (!summary.success || !isRecord(body)) return null
  return { ...summary.data, definition: normalizeDefinition(body.definition) }
}

function normalizeWorkflowList(raw: unknown): WorkflowSummary[] {
  const items = isRecord(raw) ? raw.items : undefined
  return lenientList(guard(WorkflowSummarySchema)).parse(items)
}

function normalizeRevisions(raw: unknown): WorkflowRevision[] {
  const items = isRecord(raw) ? raw.revisions : undefined
  // The guard keeps the readable rows; the parse keeps only the fields the history reads.
  return lenientList(guard(RevisionSchema)).parse(items).map((item) => RevisionSchema.parse(item))
}

function normalizeValidation(raw: unknown): WorkflowValidation {
  const parsed = ValidationResultSchema.safeParse(raw)
  return parsed.success
    ? parsed.data
    : { valid: false, errors: [{ message: 'The validation answer was unreadable', node_id: undefined }], warnings: [] }
}

// ── REST ─────────────────────────────────────────────────────────────────────

export const workflowsKeys = {
  all: () => ['workflows'] as const,
  list: () => ['workflows', 'list'] as const,
  detail: (id: string) => ['workflows', 'detail', id] as const,
  /** Under the workflow's detail key, so invalidating the detail covers its revisions too. */
  revision: (id: string, revision: number) => ['workflows', 'detail', id, 'revision', revision] as const,
}

const path = (id: string, suffix = '') => `/workflows/${encodeURIComponent(id)}${suffix}`

/**
 * Put a workflow the client just created into its `GET /workflows/{id}` cache
 * entry, so an editor opened on it renders at once (not a skeleton, nor the
 * previous workflow). A view without a readable definition is left to the fetch.
 */
export function seedWorkflowDetail(queryClient: QueryClient, view: WorkflowView): void {
  if (view.definition === null) return
  queryClient.setQueryData(workflowsKeys.detail(view.workflow_id), { workflow: view, revisions: [] })
}

function requireView(raw: unknown): WorkflowView {
  const view = normalizeWorkflowView(raw)
  if (view === null) throw new Error('The workflow answer was unreadable')
  return view
}

export const workflowsApi = {
  list: async (): Promise<WorkflowSummary[]> => normalizeWorkflowList(await fetchApi<unknown>('/workflows')),

  get: async (id: string): Promise<{ workflow: WorkflowView; revisions: WorkflowRevision[] }> => {
    const raw = await fetchApi<unknown>(path(id))
    return { workflow: requireView(raw), revisions: normalizeRevisions(raw) }
  },

  /** One saved revision (read-only history); 404 for a revision the workflow does not have. */
  getRevision: async (id: string, revision: number): Promise<WorkflowRevisionDetail> =>
    normalizeRevisionDetail(await fetchApi<unknown>(path(id, `/revisions/${revision}`))),

  create: async (definition: WorkflowDefinition): Promise<WorkflowView> =>
    requireView(await fetchApi<unknown>('/workflows', post({ definition }))),

  /** A new revision; the API answers 409 when `expectedRevision` is stale. */
  save: async (id: string, definition: WorkflowDefinition, expectedRevision: number): Promise<WorkflowView> =>
    requireView(await fetchApi<unknown>(path(id), put({ definition, expected_revision: expectedRevision }))),

  /** "Save as": a copy of the CURRENT stored revision, with lineage. */
  duplicate: async (id: string, name?: string): Promise<WorkflowView> =>
    requireView(await fetchApi<unknown>(path(id, '/duplicate'), post(name === undefined ? {} : { name }))),

  /** A new revision with only the name changed (admin); 409 for the built-in template or a concurrent save. */
  rename: async (id: string, name: string): Promise<WorkflowView> =>
    requireView(await fetchApi<unknown>(path(id, '/rename'), post({ name }))),

  /**
   * Archive (soft, admin): hidden from the library and read-only. The API answers
   * 409 for the built-in template and while an active agent still runs it.
   */
  archive: async (id: string): Promise<WorkflowSummary> =>
    requireView(await fetchApi<unknown>(path(id), del())),

  /** The importable file: the definition plus `exported_from`. */
  exportDefinition: async (id: string): Promise<unknown> => fetchApi<unknown>(path(id, '/export')),

  validate: async (definition: unknown, workflowId?: string): Promise<WorkflowValidation> =>
    normalizeValidation(await fetchApi<unknown>('/workflows/validate', post({
      definition,
      ...(workflowId === undefined ? {} : { workflow_id: workflowId }),
    }))),
}
