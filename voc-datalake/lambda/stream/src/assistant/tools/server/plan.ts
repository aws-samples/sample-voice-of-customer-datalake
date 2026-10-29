/**
 * Plan-mode read tools of the `core` pack (docs/assistant-plan-mode.md, the
 * integrator's deviation 3): every page can plan, without loading every pack.
 *
 *   - `plan_catalogue`: one line per tool of every pack the caller may use
 *     (name, pack, read/write, purpose, admin-only, free-text fields, "asks
 *     again"), plus the plan rules. Text only: it widens what the model KNOWS,
 *     never what this run can call.
 *   - `plan_lookup {tool, args}`: runs ONE read-only server tool of any pack the
 *     caller may use, with that tool's own input validation and the caller's
 *     claims — so a plan can be grounded in facts (ids, existing projects)
 *     before approval. Admin-only reads stay admin-only; writes are never
 *     reachable here (only `kind: 'server'` tools are).
 *   - `get_plan {plan_id}`: a plan's progress, `GET /agents/plans/{plan_id}`.
 */
import { z } from 'zod';
import { ADMIN_ONLY_CLIENT_TOOLS, ADMIN_ONLY_PACKS, ADMIN_ONLY_SERVER_TOOLS, TOOL_PACKS, type ToolPack } from '../../contract.js';
import type { AssistantRunContext, AssistantToolDefinition, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { isRecord } from '../../../lib/is-record.js';
import { jsonResult } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import { FREE_TEXT_FIELDS, NEVER_PREAPPROVABLE_TOOLS, PLAN_CONTROL_TOOLS, PLAN_ID_RE, PLAN_LIMITS } from '../../plan/schema.js';
import { THINK_DEFAULT_OUTPUT } from '../../plan/outputs.js';
import { seg, serverTool } from './common.js';

export type CatalogueSource = () => readonly AssistantToolDefinition[];

/** Tools about plans themselves: never a plan step, never listed, never looked up. */
const PLAN_META_TOOLS: ReadonlySet<string> = new Set(['get_plan', 'plan_catalogue', 'plan_lookup', ...PLAN_CONTROL_TOOLS]);
const ADMIN_ONLY_TOOLS: ReadonlySet<string> = new Set([...ADMIN_ONLY_CLIENT_TOOLS, ...ADMIN_ONLY_SERVER_TOOLS]);
const NEVER_PREAPPROVABLE: ReadonlySet<string> = new Set(NEVER_PREAPPROVABLE_TOOLS);

/** Packs a caller may plan with: every pack, admin-only packs for admins only (deviation 4). */
export function planPacksFor(isAdmin: boolean): ToolPack[] {
  return TOOL_PACKS.filter((pack) => isAdmin || !ADMIN_ONLY_PACKS.includes(pack));
}

/** The catalogue tools a caller may plan with, in catalogue order. */
export function plannableTools(catalogue: readonly AssistantToolDefinition[], isAdmin: boolean): AssistantToolDefinition[] {
  const packs = planPacksFor(isAdmin);
  return catalogue.filter((tool) => !PLAN_META_TOOLS.has(tool.name)
    && packs.includes(tool.pack)
    && (isAdmin || !ADMIN_ONLY_TOOLS.has(tool.name)));
}

const MAX_PURPOSE_CHARS = 160;

/** The first sentence of a tool's description. */
function purposeOf(tool: AssistantToolDefinition): string {
  const description = tool.spec.toolSpec?.description ?? '';
  const sentence = /^.*?[.!?](?=\s|$)/s.exec(description)?.[0] ?? description;
  return sentence.replaceAll(/\s+/g, ' ').trim().slice(0, MAX_PURPOSE_CHARS);
}

function catalogueLine(tool: AssistantToolDefinition): string {
  const flags = [
    tool.kind === 'server' ? 'read' : 'write',
    ...(ADMIN_ONLY_TOOLS.has(tool.name) || ADMIN_ONLY_PACKS.includes(tool.pack) ? ['admin-only'] : []),
    ...(NEVER_PREAPPROVABLE.has(tool.name) ? ['asks again at run time'] : []),
  ];
  const free = FREE_TEXT_FIELDS[tool.name];
  const freeText = free === undefined ? '' : ` | free: ${free.join(', ')}`;
  return `- ${tool.name} | ${tool.pack} | ${flags.join(', ')}${freeText} — ${purposeOf(tool)}`;
}

const PLAN_RULES = [
  'Plan rules (voc-plan/1): steps {id: "s1".., pack, kind, title, after?: [ids], produces?: [output names]}.',
  `kind "write" {write: {tool, args}} — one write tool of the step's pack (at most ${PLAN_LIMITS.writes});`,
  `kind "wait" {wait: {for: source_run {source, execution_id} | project_job {project_id, job_id} | scraper_run {scraper_id, execution_id}}} (at most ${PLAN_LIMITS.waits});`,
  `kind "think" {think: {brief}} — a read-only agent with its pack's read tools; its result text is the output "${THINK_DEFAULT_OUTPUT}" unless produces names it (at most ${PLAN_LIMITS.thinks}).`,
  `At most ${PLAN_LIMITS.steps} steps. Arg values: literals (shown to the user and approved as-is), "{{s2.project_id}}" `
    + '(an output of a step this one runs after), or "{{free}}" (only on a free: field; written at run time).',
  'Outputs a write produces: project_id, job_id, execution_id, app_config_id, document_id, persona_ids, run_id, workflow_id, agent_id.',
  'Scope every generation job to the plan\u2019s subject with LITERALS the user approves: generate_personas.custom_instructions, '
    + 'generate_document.feature_idea and merge_documents.instructions are never "{{free}}" or a step reference — write them '
    + 'out (e.g. custom_instructions "Example Air customers, from Example Air reviews only"), and pin the job\u2019s feedback with '
    + 'sources: an app connector imports as "<app_name>_iOS" / "<app_name>_Android" (its app_name argument, exactly), '
    + 'so a connector with app_name "ExampleAir" is sources ["ExampleAir_iOS"]; a web_reviews connector imports as '
    + '"web_<site>_<app_name>" (its app_name lower-cased, other characters as "_"), so app_name "Example Air" on '
    + 'https://www.trustpilot.com/review/www.example-air.com is sources ["web_trustpilot_example_air"]. '
    + 'Without sources a job reads every source the user can see.',
].join('\n');

function catalogueTool(catalogue: CatalogueSource): ServerToolDefinition {
  return serverTool('plan_catalogue', 'core', toolSpec(
    'plan_catalogue',
    'Every tool of every page you may plan with, one line each (name | pack | read/write | flags | free-text fields '
      + '— purpose), and the plan rules. Call it first for a request with several steps across pages; tools listed '
      + 'here exist even when this page does not load them.',
    {},
  ), (input, ctx) => {
    parseToolInput(z.object({}).strict(), input);
    const lines = plannableTools(catalogue(), ctx.isAdmin).map(catalogueLine);
    return Promise.resolve({ content: `${PLAN_RULES}\n\nTools:\n${lines.join('\n')}` });
  });
}

const lookupInput = z.object({ tool: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).optional() }).strict();

/** The read tool `name` this caller may run through plan_lookup, else a refusal. */
function lookupTarget(catalogue: CatalogueSource, name: string, ctx: AssistantRunContext): ServerToolDefinition {
  const tool = plannableTools(catalogue(), ctx.isAdmin).find((candidate) => candidate.name === name);
  if (tool?.kind !== 'server') {
    throw new AssistantToolError('invalid_input', `${name} is not a read tool you may use; plan_catalogue lists them.`);
  }
  if (tool.name === 'web_search' && ctx.props.useWebSearch !== true) {
    throw new AssistantToolError('not_permitted', 'Web search is off for this conversation.');
  }
  return tool;
}

function lookupTool(catalogue: CatalogueSource): ServerToolDefinition {
  return serverTool('plan_lookup', 'core', toolSpec(
    'plan_lookup',
    'Run one READ tool of any page (from plan_catalogue) to resolve a fact a plan needs before approval, e.g. '
      + 'list_scrapers, get_project, find_app_store_app. `args` are that tool\u2019s own arguments. Never writes.',
    {
      tool: { type: 'string', maxLength: 64, description: 'A read tool name from plan_catalogue.' },
      args: { type: 'object', description: 'That tool\u2019s arguments.' },
    },
    ['tool'],
  ), async (input, ctx) => {
    const { tool, args } = parseToolInput(lookupInput, input);
    return lookupTarget(catalogue, tool, ctx).execute(args ?? {}, ctx);
  });
}

/** A plan id argument (get_plan, cancel_plan). */
export const planIdSchema = z.string().regex(PLAN_ID_RE, 'a plan id (pl_ + 12 hex)');
const getPlanInput = z.object({ plan_id: planIdSchema }).strict();

function getPlanTool(deps: ToolDeps): ServerToolDefinition {
  return serverTool('get_plan', 'core', toolSpec(
    'get_plan',
    'Progress of an approved plan: its status and each step\u2019s status, outputs (ids; a think step\u2019s result text), error, or the write waiting '
      + 'for approval. Only the user who approved it (or an administrator) can read it.',
    { plan_id: { type: 'string', maxLength: 15, description: 'Plan id (pl_…) from the propose_plan result.' } },
    ['plan_id'],
  ), async (input, ctx) => {
    const { plan_id: planId } = parseToolInput(getPlanInput, input);
    const body = await deps.invoke({
      fn: 'agents', method: 'GET', path: `/agents/plans/${seg(planId)}`, resource: '/agents/{proxy+}', pathParameters: { proxy: `plans/${planId}` },
    }, ctx.claims);
    return { content: jsonResult(isRecord(body) && 'plan' in body ? body.plan : body) };
  });
}

export function createPlanServerTools(deps: ToolDeps, catalogue: CatalogueSource): ServerToolDefinition[] {
  return [getPlanTool(deps), catalogueTool(catalogue), lookupTool(catalogue)];
}
