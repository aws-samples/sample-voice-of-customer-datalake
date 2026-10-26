/**
 * Autonomous-agent and workflow-definition argument schemas, shared by the
 * `validate_workflow` server tool and the `agents` pack's write tools.
 *
 * They mirror the agents Lambda's model (brief §C, `lambda/api/agents_handler.py`)
 * and are the SPA approval boundary's contract too: the frontend's agent
 * approval schemas must accept exactly what these accept (same keys, enums and
 * limits). The `const NAME = [ … ] as const` / `{ … } as const` literals
 * below are plain on purpose so a frontend lockstep test can read this file as
 * text, like `client/allowlists.ts`.
 *
 * Structural rules the Lambda checks on validate (one start, reachable end, no
 * orphans, cycles only inside declared loops) are NOT re-implemented here: the
 * schema bounds shape and size, `POST /workflows/validate` judges the graph.
 */
import { z } from 'zod';
import type { DocumentType } from '@smithy/types';
import { idProperty, idSchema } from './spec.js';

const WORKFLOW_SCHEMA_VERSION = 'voc-workflow/1';

// jscpd:ignore-start — mirrors frontend/src/api/workflowsApi.ts and frontend/src/assistant/approvals/agentSchemas.ts on purpose: separate packages, pinned by newTools.lockstep.test.ts
const WORKFLOW_NODE_TYPES = [
  'start', 'aggregate_reviews', 'select_or_create_project', 'select_personas', 'generate_personas',
  'deep_research', 'write_prfaq', 'write_prd', 'persona_review', 'revise_document', 'build_prototype',
  'collect_prototype_feedback', 'revise_prototype', 'final_review', 'duplicate_document', 'handoff', 'custom_llm', 'end',
] as const;
const WORKFLOW_NODE_ROLES = ['orchestrator', 'worker', 'reviewer', 'persona'] as const;
const WORKFLOW_EDGE_LABELS = ['pass', 'fail', 'agreed', 'not_agreed'] as const;
const WORKFLOW_LOOP_UNTIL = ['persona_agreement', 'review_pass'] as const;

export const WORKFLOW_LIMITS = {
  maxNodes: 60,
  maxEdges: 200,
  maxLoops: 20,
  minRounds: 1,
  maxRounds: 5,
  maxNameChars: 200,
  maxDescriptionChars: 2000,
  maxTitleChars: 200,
  maxInstructionsChars: 8000,
  maxParamsJsonChars: 4000,
  maxDefinitionJsonChars: 200_000,
} as const;

const AGENT_SCHEDULE_EVERY = ['12h', '24h', 'cron'] as const;
const AGENT_THRESHOLD_PER = ['category', 'subcategory'] as const;
const AGENT_VISIBILITIES = ['private', 'public'] as const;
const AGENT_MODEL_ROLES = ['orchestrator', 'worker', 'reviewer', 'persona'] as const;

export const AGENT_LIMITS = {
  maxNameChars: 200,
  maxDescriptionChars: 2000,
  maxInstructionsChars: 8000,
  maxCategories: 50,
  maxSubcategories: 100,
  maxCategoryNameChars: 64,
  maxFixedPersonas: 20,
  maxTriggers: 5,
  maxCooldownHours: 720,
  maxMinNew: 10_000,
  maxThresholdCount: 100_000,
  maxWindowDays: 365,
  maxCronChars: 100,
  maxTimezoneChars: 64,
  maxModelIdChars: 128,
  maxScheduledRunsPerDay: 2,
  maxModelCallsPerRun: 1000,
  maxMonthlyCallCap: 1_000_000,
} as const;
// jscpd:ignore-end of the accepted pair

const jsonLength = (value: unknown) => JSON.stringify(value).length;

// ── Workflow definition ──

const nodeSchema = z.object({
  id: idSchema,
  type: z.enum(WORKFLOW_NODE_TYPES),
  position: z.object({ x: z.number(), y: z.number() }).strict(),
  data: z.object({
    title: z.string().trim().min(1).max(WORKFLOW_LIMITS.maxTitleChars),
    instructions: z.string().max(WORKFLOW_LIMITS.maxInstructionsChars).optional(),
    role: z.enum(WORKFLOW_NODE_ROLES).optional(),
    params: z.record(z.string(), z.unknown())
      .refine((params) => jsonLength(params) <= WORKFLOW_LIMITS.maxParamsJsonChars, 'params are too large')
      .optional(),
  }).strict(),
}).strict();

const edgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  label: z.enum(WORKFLOW_EDGE_LABELS).optional(),
}).strict();

const loopSchema = z.object({
  node_ids: z.array(idSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
  until: z.enum(WORKFLOW_LOOP_UNTIL),
  max_rounds: z.number().int().min(WORKFLOW_LIMITS.minRounds).max(WORKFLOW_LIMITS.maxRounds),
}).strict();

export const workflowDefinitionSchema = z.object({
  schema: z.literal(WORKFLOW_SCHEMA_VERSION),
  name: z.string().trim().min(1).max(WORKFLOW_LIMITS.maxNameChars),
  description: z.string().max(WORKFLOW_LIMITS.maxDescriptionChars).optional(),
  nodes: z.array(nodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
  edges: z.array(edgeSchema).max(WORKFLOW_LIMITS.maxEdges),
  loops: z.array(loopSchema).max(WORKFLOW_LIMITS.maxLoops),
}).strict().refine(
  (definition) => jsonLength(definition) <= WORKFLOW_LIMITS.maxDefinitionJsonChars,
  'the definition is too large',
);

/** Model-facing JSON schema of a definition (shape only; the zod schema is the judge). */
export const WORKFLOW_DEFINITION_PROPERTY: DocumentType = {
  type: 'object',
  description: `A complete workflow definition: {schema: "${WORKFLOW_SCHEMA_VERSION}", name, description?, `
    + 'nodes: [{id, type, position: {x, y}, data: {title, instructions?, role?, params?}}], '
    + 'edges: [{id, source, target, label?: pass|fail|agreed|not_agreed}], '
    + 'loops: [{node_ids, until: persona_agreement|review_pass, max_rounds: 1-5}]}. '
    + `Node types: ${WORKFLOW_NODE_TYPES.join(', ')}. persona_review params: {target: prfaq|prd|prototype}. `
    + `At most ${WORKFLOW_LIMITS.maxNodes} nodes; one start, a reachable end, no orphan nodes, cycles only inside loops.`,
};

// ── Agent configuration ──

const categoryName = z.string().trim().min(1).max(AGENT_LIMITS.maxCategoryNameChars);

const agentScopeSchema = z.object({
  all: z.boolean(),
  categories: z.array(categoryName).max(AGENT_LIMITS.maxCategories),
  subcategories: z.array(z.object({ category: categoryName, name: categoryName }).strict()).max(AGENT_LIMITS.maxSubcategories),
}).strict().refine(
  (scope) => scope.all || scope.categories.length > 0 || scope.subcategories.length > 0,
  'scope needs all=true or at least one category or subcategory',
);

const agentPersonasSchema = z.object({
  fixed: z.array(z.object({ project_id: idSchema, persona_id: idSchema }).strict()).max(AGENT_LIMITS.maxFixedPersonas),
  allow_generate: z.boolean(),
}).strict();

const agentTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new_reviews'),
    min_new: z.number().int().min(1).max(AGENT_LIMITS.maxMinNew),
    cooldown_hours: z.number().int().min(0).max(AGENT_LIMITS.maxCooldownHours),
  }).strict(),
  z.object({
    kind: z.literal('schedule'),
    every: z.enum(AGENT_SCHEDULE_EVERY),
    cron: z.string().trim().min(1).max(AGENT_LIMITS.maxCronChars).optional(),
    timezone: z.string().trim().min(1).max(AGENT_LIMITS.maxTimezoneChars),
  }).strict(),
  z.object({
    kind: z.literal('threshold'),
    count: z.number().int().min(1).max(AGENT_LIMITS.maxThresholdCount),
    per: z.enum(AGENT_THRESHOLD_PER),
    window_days: z.number().int().min(1).max(AGENT_LIMITS.maxWindowDays),
  }).strict(),
]).refine(
  (trigger) => trigger.kind !== 'schedule' || (trigger.every === 'cron') === (trigger.cron !== undefined),
  'a schedule needs cron exactly when every is "cron"',
);

/** Per-role model override; null = the role's surface default (Settings → AI models). */
const modelOverride = z.string().trim().min(1).max(AGENT_LIMITS.maxModelIdChars).nullable();

const agentModelsSchema = z.object(
  Object.fromEntries(AGENT_MODEL_ROLES.map((role) => [role, modelOverride.optional()])),
).strict();

const agentBudgetSchema = z.object({
  max_scheduled_runs_per_day: z.number().int().min(0).max(AGENT_LIMITS.maxScheduledRunsPerDay),
  max_model_calls_per_run: z.number().int().min(1).max(AGENT_LIMITS.maxModelCallsPerRun),
  monthly_call_cap: z.number().int().min(0).max(AGENT_LIMITS.maxMonthlyCallCap),
}).partial().strict();

/** Every configurable agent field (create: name + scope required; update: any non-empty subset). */
export const agentFieldsShape = {
  name: z.string().trim().min(1).max(AGENT_LIMITS.maxNameChars),
  description: z.string().max(AGENT_LIMITS.maxDescriptionChars),
  scope: agentScopeSchema,
  instructions: z.string().max(AGENT_LIMITS.maxInstructionsChars),
  personas: agentPersonasSchema,
  triggers: z.array(agentTriggerSchema).max(AGENT_LIMITS.maxTriggers),
  models: agentModelsSchema,
  output: z.object({ visibility: z.enum(AGENT_VISIBILITIES) }).strict(),
  workflow_id: idSchema,
  budget: agentBudgetSchema,
};

/** Model-facing JSON schema fragments of the agent fields. */
export const AGENT_FIELD_PROPERTIES: Record<keyof typeof agentFieldsShape, DocumentType> = {
  name: { type: 'string', maxLength: AGENT_LIMITS.maxNameChars, description: 'Agent name.' },
  description: { type: 'string', maxLength: AGENT_LIMITS.maxDescriptionChars, description: 'What the agent is for.' },
  scope: {
    type: 'object',
    description: 'Feedback it watches: {all: bool, categories: [names], subcategories: [{category, name}]} — names '
      + 'from list_categories; all=true for every category.',
  },
  instructions: { type: 'string', maxLength: AGENT_LIMITS.maxInstructionsChars, description: 'Custom instructions for the whole crew.' },
  personas: { type: 'object', description: '{fixed: [{project_id, persona_id}], allow_generate: bool}.' },
  triggers: {
    type: 'array',
    maxItems: AGENT_LIMITS.maxTriggers,
    items: { type: 'object' },
    description: 'What wakes it: {kind: "new_reviews", min_new, cooldown_hours} | {kind: "schedule", every: '
      + '"12h"|"24h"|"cron", cron? (only with every="cron"), timezone} | {kind: "threshold", count, per: '
      + '"category"|"subcategory", window_days}.',
  },
  models: {
    type: 'object',
    description: 'Optional per-role model ids {orchestrator, worker, reviewer, persona}; null = the Settings default.',
  },
  output: { type: 'object', description: '{visibility: "private"|"public"} of the projects it hands off.' },
  workflow_id: idProperty('Workflow it runs (wf_default = "Reviews → Prototype").'),
  budget: {
    type: 'object',
    description: `{max_scheduled_runs_per_day: 0-${AGENT_LIMITS.maxScheduledRunsPerDay}, max_model_calls_per_run, `
      + 'monthly_call_cap}. Manual runs do not count against the daily limit.',
  },
};
