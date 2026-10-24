/**
 * `agents` pack server tools — read-only views of the autonomous agents, their
 * workflows and runs, plus a dry-run workflow validation. All read the agents
 * Lambda as the caller: it lists only the agents whose scope the caller can
 * see. The agent on screen (`page.agentId`) is the default subject.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import { WORKFLOW_DEFINITION_PROPERTY, workflowDefinitionSchema } from '../agent-schemas.js';
import type { ToolDeps } from '../deps.js';
import { AssistantToolError } from '../errors.js';
import { firstString, isRecord, jsonResult, pick } from '../format.js';
import { WORKFLOW_VALIDATE_RESOURCE } from '../internal-api.js';
import { idProperty, idSchema, parseToolInput, resolveId, toolSpec } from '../spec.js';
import { recordsAt } from './feedback-shape.js';
import { seg, serverTool } from './common.js';

const AGENT_LIST_FIELDS = [
  'agent_id', 'name', 'description', 'enabled', 'scope', 'triggers', 'workflow_id', 'output', 'stats', 'updated_at',
] as const;
const AGENT_FIELDS = [
  ...AGENT_LIST_FIELDS, 'instructions', 'personas', 'models', 'budget', 'created_at',
] as const;
const RUN_FIELDS = [
  'run_id', 'agent_id', 'status', 'trigger', 'started_at', 'finished_at', 'project_id', 'current_node_id',
  'model_calls', 'error',
] as const;
const EVENT_FIELDS = ['seq', 'at', 'kind', 'node_id', 'role', 'summary', 'ref'] as const;

const MAX_RUNS = 50;
const DEFAULT_RUNS = 10;
const MAX_EVENTS = 100;
const MAX_REPORTED_ISSUES = 20;
const INSTRUCTIONS_CHARS = 8000;
/** A 60-node definition with instructions outgrows the default result budget. */
const WORKFLOW_RESULT_BUDGET = 30_000;
const RUN_RESULT_BUDGET = 20_000;

const AGENT_ID = idProperty('Agent id; omit to use the agent on screen.');

const noInput = z.object({}).strict();
const agentInput = z.object({ agent_id: idSchema.optional() }).strict();
const workflowInput = z.object({ workflow_id: idSchema.optional() }).strict();
const runsInput = z.object({ agent_id: idSchema.optional(), limit: z.number().int().min(1).max(MAX_RUNS).optional() }).strict();
const runInput = z.object({
  agent_id: idSchema.optional(),
  run_id: idSchema,
  include_events: z.boolean().optional(),
  after: z.number().int().min(0).optional(),
}).strict();
const validateInput = z.object({ definition: z.unknown() }).strict();

type Get = (path: string, resource: string, pathParameters?: Record<string, string>, query?: Record<string, number | undefined>) => Promise<unknown>;

function getter(deps: ToolDeps, ctx: AssistantRunContext): Get {
  return (path, resource, pathParameters, query) => deps.invoke({
    fn: 'agents', method: 'GET', path, resource, ...(pathParameters ? { pathParameters } : {}), ...(query ? { query } : {}),
  }, ctx.claims);
}

function readAgent(get: Get, agentId: string): Promise<unknown> {
  return get(`/agents/${seg(agentId)}`, '/agents/{id}', { id: agentId });
}

/** The record of a single-item response: the body itself, or under `key` (`{agent: …}`, `{run: …}`). */
function unwrapRecord(body: unknown, key: string, what: string): Record<string, unknown> {
  const record = isRecord(body) && isRecord(body[key]) ? body[key] : body;
  if (!isRecord(record)) throw new AssistantToolError('unavailable', `The ${what} could not be read.`);
  return record;
}

function agentRecord(body: unknown): Record<string, unknown> {
  return unwrapRecord(body, 'agent', 'agent');
}

function listAgentsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_agents',
    'The autonomous agents the user can see: name, enabled, the categories they watch, triggers, workflow and run stats.',
    {},
  );
  return serverTool('list_agents', 'agents', spec, async (input, ctx) => {
    parseToolInput(noInput, input);
    const agents = recordsAt(await getter(deps, ctx)('/agents', '/agents'), 'agents');
    return { content: jsonResult({ count: agents.length, agents: agents.map((agent) => pick(agent, AGENT_LIST_FIELDS, 300)) }) };
  });
}

function getAgentTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_agent',
    'One autonomous agent in full (defaults to the agent on screen): scope, instructions, personas, triggers, '
      + 'per-role models, output visibility, workflow id, budget and stats. Read it before proposing update_agent.',
    { agent_id: AGENT_ID },
  );
  return serverTool('get_agent', 'agents', spec, async (input, ctx) => {
    const args = parseToolInput(agentInput, input);
    const agentId = resolveId(args.agent_id, ctx.page.agentId, 'agent_id');
    const agent = agentRecord(await readAgent(getter(deps, ctx), agentId));
    return { content: jsonResult(pick(agent, AGENT_FIELDS, INSTRUCTIONS_CHARS)) };
  });
}

/** The explicit workflow id, else the workflow of the agent on screen. */
async function resolveWorkflowId(get: Get, explicit: string | undefined, ctx: AssistantRunContext): Promise<string> {
  if (explicit !== undefined) return explicit;
  const agentId = resolveId(undefined, ctx.page.agentId, 'workflow_id (or an agent on screen)');
  const workflowId = firstString(agentRecord(await readAgent(get, agentId)).workflow_id);
  const parsed = idSchema.safeParse(workflowId);
  if (!parsed.success) throw new AssistantToolError('not_found', 'The agent on screen has no workflow.');
  return parsed.data;
}

function getWorkflowTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_workflow',
    'A workflow (defaults to the workflow of the agent on screen): its current definition (nodes, edges, loops), '
      + 'current revision and the revision list. Read it before proposing update_workflow, and pass its revision as '
      + 'expected_revision.',
    { workflow_id: idProperty('Workflow id; omit to use the workflow of the agent on screen.') },
  );
  return serverTool('get_workflow', 'agents', spec, async (input, ctx) => {
    const args = parseToolInput(workflowInput, input);
    const get = getter(deps, ctx);
    const workflowId = await resolveWorkflowId(get, args.workflow_id, ctx);
    const body = await get(`/workflows/${seg(workflowId)}`, '/workflows/{id}', { id: workflowId });
    return { content: jsonResult(body, WORKFLOW_RESULT_BUDGET) };
  });
}

function listAgentRunsTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'list_agent_runs',
    'Recent runs of an agent (defaults to the agent on screen), newest first: status, trigger, timing, the project '
      + 'it worked in, current node, model calls, error.',
    {
      agent_id: AGENT_ID,
      limit: { type: 'integer', minimum: 1, maximum: MAX_RUNS, description: `Max runs (default ${DEFAULT_RUNS}).` },
    },
  );
  return serverTool('list_agent_runs', 'agents', spec, async (input, ctx) => {
    const args = parseToolInput(runsInput, input);
    const agentId = resolveId(args.agent_id, ctx.page.agentId, 'agent_id');
    const limit = args.limit ?? DEFAULT_RUNS;
    const body = await getter(deps, ctx)(`/agents/${seg(agentId)}/runs`, '/agents/{id}/runs', { id: agentId }, { limit });
    const runs = recordsAt(body, 'runs').slice(0, limit);
    return { content: jsonResult({ agent_id: agentId, returned: runs.length, runs: runs.map((run) => pick(run, RUN_FIELDS, 500)) }) };
  });
}

function getAgentRunTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'get_agent_run',
    'One agent run: status, timing, project, current node, model calls, error; optionally its event log (node '
      + 'started/finished/failed, verdicts, decisions, artifacts with project/document/persona refs).',
    {
      agent_id: AGENT_ID,
      run_id: idProperty('Run id (ar_…) from list_agent_runs.'),
      include_events: { type: 'boolean', description: `Also return up to ${MAX_EVENTS} events.` },
      after: { type: 'integer', minimum: 0, description: 'Only events after this sequence number.' },
    },
    ['run_id'],
  );
  return serverTool('get_agent_run', 'agents', spec, async (input, ctx) => {
    const args = parseToolInput(runInput, input);
    const agentId = resolveId(args.agent_id, ctx.page.agentId, 'agent_id');
    const get = getter(deps, ctx);
    const params = { id: agentId, run_id: args.run_id };
    const base = `/agents/${seg(agentId)}/runs/${seg(args.run_id)}`;
    const [runBody, eventsBody] = await Promise.all([
      get(base, '/agents/{id}/runs/{run_id}', params),
      args.include_events === true
        ? get(`${base}/events`, '/agents/{id}/runs/{run_id}/events', params, { after: args.after })
        : Promise.resolve(),
    ]);
    const events = eventsBody === undefined ? undefined : recordsAt(eventsBody, 'events').slice(0, MAX_EVENTS);
    return {
      content: jsonResult({
        run: pick(unwrapRecord(runBody, 'run', 'agent run'), RUN_FIELDS, 1000),
        ...(events ? { events: events.map((event) => pick(event, EVENT_FIELDS, 500)) } : {}),
      }, RUN_RESULT_BUDGET),
    };
  });
}

function validateWorkflowTool(deps: ToolDeps): ServerToolDefinition {
  const spec = toolSpec(
    'validate_workflow',
    'Check a complete workflow definition without saving it: returns {valid, errors: [{node_id?, message}]}. '
      + 'ALWAYS call this, and fix every error, before proposing create_workflow or update_workflow.',
    { definition: WORKFLOW_DEFINITION_PROPERTY },
    ['definition'],
  );
  return serverTool('validate_workflow', 'agents', spec, async (input, ctx) => {
    const { definition } = parseToolInput(validateInput, input);
    // Shape first: the same bounds the write tools enforce, reported like the API's errors.
    const shape = workflowDefinitionSchema.safeParse(definition);
    if (!shape.success) {
      const errors = shape.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        message: issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      }));
      return { content: jsonResult({ valid: false, errors }) };
    }
    const body = await deps.invoke({
      fn: 'agents', method: 'POST', path: WORKFLOW_VALIDATE_RESOURCE, resource: WORKFLOW_VALIDATE_RESOURCE,
      body: { definition: shape.data },
    }, ctx.claims);
    return { content: jsonResult(body) };
  });
}

export function createAgentsServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [
    listAgentsTool(deps),
    getAgentTool(deps),
    getWorkflowTool(deps),
    listAgentRunsTool(deps),
    getAgentRunTool(deps),
    validateWorkflowTool(deps),
  ];
}
