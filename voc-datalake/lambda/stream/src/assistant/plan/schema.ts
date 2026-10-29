/**
 * Plan mode — the `voc-plan/1` wire format (docs/assistant-plan-mode.md → "Plan format").
 *
 * A plan is a small DAG of steps. Each step runs with exactly ONE pack's tools:
 *   - `write`: one write tool with declared arguments;
 *   - `wait`:  polls a background job (`source_run`, `project_job`, `scraper_run`);
 *   - `think`: a read-only agent with the pack's server tools and a brief.
 *
 * Argument values are literals, references `{{<step>.<output>}}` to an earlier
 * step's recorded output, or `{{free}}` (a FREE_TEXT_FIELDS field the runner lets
 * the model write at run time). The zod schemas here pin the SHAPE; the
 * cross-step rules (limits, DAG, references, packs, admin gating, literals) are
 * `validate.ts`.
 *
 * LOCKSTEP: `frontend/src/assistant/plan/schema.ts` mirrors every export
 * (`plan.lockstep.test.ts` there), and `lambda/shared/plan_contract.json` is
 * generated from these constants for the Python validator (`contract-json.ts`).
 */
import { z } from 'zod';
import { CLIENT_TOOLS, PLAN_TOOL_NAMES, TOOL_PACKS, type ToolPack } from '../contract.js';

export const PLAN_SCHEMA = 'voc-plan/1';

export const PLAN_LIMITS = {
  steps: 20,
  writes: 12,
  waits: 6,
  thinks: 4,
  /** An unapproved (proposed) plan expires after this. */
  approvalTtlMinutes: 30,
  /** An approved plan that has not started expires after this. */
  startTtlHours: 24,
  /** Model calls per plan (planner excluded). */
  modelCalls: 60,
  /** Background jobs a plan may start. */
  jobs: 6,
} as const;

/** Text and list bounds of the format itself (tool arguments keep their own tool's bounds). */
export const PLAN_FIELD_LIMITS = {
  goalChars: 500,
  titleChars: 120,
  briefChars: 2000,
  afterItems: 20,
  producesItems: 8,
  argKeyChars: 64,
  /** Canonical JSON of the whole plan (one DynamoDB item with room for status). */
  planJsonChars: 64_000,
  waitTimeoutMinutesMax: 1440,
} as const;

/** `pl_<12 hex>`; cannot collide with agent ids (`ag_…`). */
export const PLAN_ID_RE = /^pl_[0-9a-f]{12}$/;
export const STEP_ID_RE = /^s\d{1,3}$/;
export const OUTPUT_NAME_RE = /^[a-z_]{1,32}$/;
/** `{{s2.execution_id}}` — group 1 is the step id, group 2 the output name. */
export const REFERENCE_RE = /^\{\{(s\d{1,3})\.([a-z_]{1,32})\}\}$/;
export const FREE_PLACEHOLDER = '{{free}}';
/** A literal id inside a `wait` (the charset of `idSchema`: no `/`, `?`, `#`, `%`), or a reference. */
export const WAIT_VALUE_RE = /^(?:[\w.:-]{1,128}|\{\{s\d{1,3}\.[a-z_]{1,32}\}\})$/;
export const SOURCE_ID_RE = /^[a-z0-9_]{1,64}$/;

export const PLAN_STEP_KINDS = ['write', 'wait', 'think'] as const;
export const PLAN_WAIT_KINDS = ['source_run', 'project_job', 'scraper_run'] as const;

export const PLAN_STEP_STATUSES = [
  'pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'needs_approval', 'cancelled',
] as const;

export const PLAN_STATUSES = [
  'awaiting_approval', 'approved', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'expired',
] as const;

/**
 * Always an approval card at run time, even when the plan lists them; the plan
 * card marks them "will ask again". (The user-administration tools and
 * `save_brand_settings` were here too; they are now CARD_ONLY_WRITE_TOOLS —
 * never a plan step at all.)
 */
export const NEVER_PREAPPROVABLE_TOOLS = ['delete_document', 'forget_memory', 'merge_memories'] as const;

/**
 * Client tools that steer plans themselves and are therefore never a step of
 * one: `propose_plan` (its args ARE a plan; approving it is the plan approval)
 * and `cancel_plan`.
 */
export const PLAN_CONTROL_TOOLS = ['propose_plan', 'cancel_plan'] as const;

/**
 * Writes that only an approval card in the bubble can run, so a plan may not
 * name them: their SPA executors re-check state the card showed (the brand
 * settings merge base, the stored user record, the signed-in admin's own
 * account) and `update_user` / `create_users` are several requests applied in
 * order. `import_reviews` carries the rows the user pasted or attached in this
 * chat (up to 500, too large for a plan step and never pre-approvable unseen),
 * and its executor derives the de-duplication ids. `save_radar_brands` and
 * `run_radar_scan` call the Radar API, which the plan-step runner may not invoke
 * (voc-plan-step has no RADAR_FUNCTION); the brand list card also re-checks the
 * list it diffed against. `create_participant_list` and `add_participants` call the
 * engagement API, which voc-plan-step may not invoke (no ENGAGEMENT_FUNCTION), and
 * `add_participants` carries up to 200 people from this chat (owner rule: bulk entry is
 * one approval card the user reads row by row). They stay ordinary chat writes.
 */
export const CARD_ONLY_WRITE_TOOLS = [
  'save_brand_settings', 'create_user', 'create_users', 'update_user', 'set_user_access', 'import_reviews',
  'save_radar_brands', 'run_radar_scan', 'create_participant_list', 'add_participants',
] as const;
const NOT_A_PLAN_WRITE: ReadonlySet<string> = new Set([...PLAN_CONTROL_TOOLS, ...CARD_ONLY_WRITE_TOOLS]);

/**
 * The write tools a step of each pack may name: the pack's CLIENT_TOOLS plus the
 * plan-mode client tools not yet moved into CLIENT_TOOLS (`PLAN_TOOL_NAMES`),
 * without PLAN_CONTROL_TOOLS and CARD_ONLY_WRITE_TOOLS.
 */
export function planWriteTools(pack: ToolPack): readonly string[] {
  const planned: Partial<Record<ToolPack, readonly string[]>> = PLAN_TOOL_NAMES.client;
  return [...new Set([...CLIENT_TOOLS[pack], ...(planned[pack] ?? [])])].filter((tool) => !NOT_A_PLAN_WRITE.has(tool));
}


/**
 * Per write tool, the argument paths (dot-separated object keys, no array
 * indices) that may hold `{{free}}`: genuine prose the user reads, never an id,
 * target, role, source, scope, enum or flag. Read from each tool's own zod
 * schema in `tools/client/*.ts`.
 *
 * Deliberately NOT listed, though they hold text: memory statements
 * (`remember`, `update_company_memory`) and company/design context, agent and
 * workflow instructions — they feed every later prompt, so text an agent read
 * must not become them unseen; feedback-form copy — it is published on
 * customers' sites; `product_name` — it names the product; the generation
 * instructions of a job (`generate_document.feature_idea`,
 * `generate_personas.custom_instructions`, `merge_documents.instructions`) —
 * they decide what the job writes about and from which feedback, so the user
 * approves them as literals on the plan card. `build_prototype`
 * is listed by the body fields of `POST /projects/{id}/build-prototype`, which
 * its tool keeps (`tools/client/plan-writes.ts`).
 */
export const FREE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create_project: ['description'],
  update_project: ['description'],
  create_document: ['title', 'content'],
  update_document: ['title', 'content', 'change_summary'],
  add_persona_note: ['text'],
  update_persona: [
    'updates.tagline',
    'updates.identity.bio',
    'updates.goals_motivations.primary_goal',
    'updates.goals_motivations.success_definition',
    'updates.pain_points.emotional_impact',
    'updates.scenario.title',
    'updates.scenario.narrative',
    'updates.scenario.trigger',
    'updates.scenario.outcome',
  ],
  update_product_context: [
    'updates.one_liner',
    'updates.target_users',
    'updates.problem_solved',
    'updates.key_features',
    'updates.differentiators',
    'updates.known_limitations',
    'updates.non_goals',
    'updates.success_metrics',
    'updates.free_form_notes',
  ],
  start_research: ['question', 'title'],
  generate_document: ['title'],
  merge_documents: ['title'],
  build_prototype: ['title', 'feedback'],
};

// ── Shape ──────────────────────────────────────────────────────────────────

const stepId = z.string().regex(STEP_ID_RE, 'must be s<digits>');
const outputName = z.string().regex(OUTPUT_NAME_RE, 'must be 1-32 of a-z and _');
const title = z.string().trim().min(1).max(PLAN_FIELD_LIMITS.titleChars);
/** A literal id or a `{{step.output}}` reference (never `{{free}}`). */
const waitRef = z.string().regex(WAIT_VALUE_RE, 'must be an id or a {{step.output}} reference');
const timeoutMinutes = z.number().int().min(1).max(PLAN_FIELD_LIMITS.waitTimeoutMinutesMax).optional();

const stepBase = {
  id: stepId,
  pack: z.enum(TOOL_PACKS),
  title,
  after: z.array(stepId).max(PLAN_FIELD_LIMITS.afterItems).optional(),
  produces: z.array(outputName).max(PLAN_FIELD_LIMITS.producesItems).optional(),
};

const planWaitSchema = z.discriminatedUnion('for', [
  z.strictObject({
    for: z.literal('source_run'),
    source: z.string().regex(SOURCE_ID_RE, 'must be a source id'),
    execution_id: waitRef,
    timeout_minutes: timeoutMinutes,
  }),
  z.strictObject({ for: z.literal('project_job'), project_id: waitRef, job_id: waitRef, timeout_minutes: timeoutMinutes }),
  z.strictObject({ for: z.literal('scraper_run'), scraper_id: waitRef, execution_id: waitRef, timeout_minutes: timeoutMinutes }),
]);

const planStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...stepBase,
    kind: z.literal('write'),
    write: z.strictObject({
      tool: z.string().min(1).max(64),
      args: z.record(z.string().min(1).max(PLAN_FIELD_LIMITS.argKeyChars), z.unknown()),
    }),
  }),
  z.strictObject({ ...stepBase, kind: z.literal('wait'), wait: planWaitSchema }),
  z.strictObject({
    ...stepBase,
    kind: z.literal('think'),
    think: z.strictObject({ brief: z.string().trim().min(1).max(PLAN_FIELD_LIMITS.briefChars) }),
  }),
]);

export const planSchema = z.strictObject({
  schema: z.literal(PLAN_SCHEMA),
  goal: z.string().trim().min(1).max(PLAN_FIELD_LIMITS.goalChars),
  steps: z.array(planStepSchema).min(1).max(PLAN_LIMITS.steps),
});

export type VocPlan = z.infer<typeof planSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;

