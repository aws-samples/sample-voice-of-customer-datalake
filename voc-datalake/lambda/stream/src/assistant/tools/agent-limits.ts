/**
 * Workflow-definition and agent-configuration vocabulary and limits: the bounds
 * of `agent-schemas.ts` (the `validate_workflow` server tool and the `agents`
 * pack's write tools), shared with the SPA, whose approval boundary
 * (`frontend/src/assistant/approvals/agentSchemas.ts`) builds its schemas from
 * these limits and whose workflow / agent API modules (`frontend/src/api/workflowsApi.ts`,
 * `agentsApi.ts`) use these enums.
 *
 * Pure on purpose (no imports): the SPA bundles it. The agents Lambda's own
 * (stricter) limits live in `lambda/shared/workflow_schema.py` / `agents_store.py`.
 */

export const WORKFLOW_SCHEMA_VERSION = 'voc-workflow/1';

export const WORKFLOW_NODE_TYPES = [
  'start', 'aggregate_reviews', 'select_or_create_project', 'select_personas', 'generate_personas',
  'deep_research', 'write_prfaq', 'write_prd', 'persona_review', 'revise_document', 'build_prototype',
  'collect_prototype_feedback', 'revise_prototype', 'final_review', 'duplicate_document', 'handoff', 'custom_llm', 'end',
] as const;
/**
 * An engineering flow (`voc-workflow/2`, `lambda/shared/workflow_engineering.py`): `start`, `end` and these steps,
 * never an agents step. The SPA offers to create one (the library's button, an assistant draft's card) only where the
 * deployment has the engineering module (config.json `features.engineering`).
 */
export const WORKFLOW_SCHEMA_V2 = 'voc-workflow/2';
export const ENGINEERING_NODE_TYPES = [
  'agent', 'map', 'reduce', 'board', 'quality_gate', 'learning_loop', 'self_improvement', 'memory', 'stop_at_pr',
] as const;
/** Every step either kind of workflow may hold (which kind holds which is the agents Lambda's graph rule). */
export const WORKFLOW_ALL_NODE_TYPES = [...WORKFLOW_NODE_TYPES, ...ENGINEERING_NODE_TYPES] as const;
export const WORKFLOW_NODE_ROLES = ['orchestrator', 'worker', 'reviewer', 'persona'] as const;
export const WORKFLOW_EDGE_LABELS = ['pass', 'fail', 'agreed', 'not_agreed'] as const;
export const WORKFLOW_LOOP_UNTIL = ['persona_agreement', 'review_pass'] as const;

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

export const AGENT_SCHEDULE_EVERY = ['12h', '24h', 'cron'] as const;
export const AGENT_THRESHOLD_PER = ['category', 'subcategory'] as const;
export const AGENT_VISIBILITIES = ['private', 'public'] as const;
export const AGENT_MODEL_ROLES = ['orchestrator', 'worker', 'reviewer', 'persona'] as const;

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

/**
 * The least model calls a run may be given (`budget.max_model_calls_per_run`). The SPA's
 * approval boundary feeds it to its agent-fields builder; `agent-schemas.ts` applies it.
 */
export const AGENT_BUDGET_RULES = { minModelCallsPerRun: 1 } as const;
