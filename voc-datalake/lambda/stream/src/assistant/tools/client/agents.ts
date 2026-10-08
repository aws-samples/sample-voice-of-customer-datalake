/**
 * `agents` pack write tools. Configuration and workflow writes are admin-only
 * (ADMIN_ONLY_CLIENT_TOOLS); run / cancel are left to the agents Lambda's own
 * rule. `agent_id` defaults to the agent on screen.
 */
import { z } from 'zod';
import type { ClientToolDefinition } from '../../types.js';
import {
  AGENT_FIELD_PROPERTIES,
  AGENT_LIMITS,
  agentFieldsShape,
  WORKFLOW_DEFINITION_PROPERTY,
  WORKFLOW_LIMITS,
  workflowDefinitionSchema,
} from '../agent-schemas.js';
import { idProperty, idSchema } from '../spec.js';
import { defineClientTool, q, stringProperty } from './define.js';

const AGENT_ID = idProperty('Agent id (defaults to the agent on screen).');
const WORKFLOW_ID = idProperty('Workflow id (from get_agent / get_workflow).');
const MAX_CHANGE_SUMMARY = 500;
const changeSummary = z.string().trim().min(1).max(MAX_CHANGE_SUMMARY);

function scopeLabel(scope: { all: boolean; categories: readonly string[]; subcategories: readonly unknown[] }): string {
  if (scope.all) return 'all categories';
  return `${scope.categories.length + scope.subcategories.length} categories/subcategories`;
}

/** A record with at least one field actually set (a key sent as undefined does not count). */
function setsAField(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => value !== undefined);
}

const createAgent = defineClientTool({
  name: 'create_agent',
  pack: 'agents',
  description: 'Create an autonomous agent (admin). It is created DISABLED — propose enable_agent separately once '
    + 'the user wants it to wake on its triggers. Without workflow_id it runs the built-in "Reviews → Prototype" '
    + 'workflow (wf_default).',
  properties: AGENT_FIELD_PROPERTIES,
  required: ['name', 'scope'],
  schema: z.object(agentFieldsShape).partial().required({ name: true, scope: true }).strict(),
  summarize: (args) => `Create autonomous agent ${q(args.name)} (disabled) watching ${scopeLabel(args.scope)}.`,
});

const agentUpdatesSchema = z.object(agentFieldsShape).partial().strict()
  .refine(setsAField, 'updates must change at least one field');

const updateAgent = defineClientTool({
  name: 'update_agent',
  pack: 'agents',
  description: 'Change an autonomous agent\u2019s configuration (admin). Read it with get_agent first. A field you '
    + 'send REPLACES the stored one (send complete scope / triggers / personas / models / budget objects). '
    + `Allowed keys in \`updates\`: ${Object.keys(agentFieldsShape).join(', ')}.`,
  properties: {
    agent_id: AGENT_ID,
    updates: { type: 'object', description: 'Fields to replace (see the allowed keys).' },
    change_summary: stringProperty('One-line description of the change, shown to the user.', MAX_CHANGE_SUMMARY),
  },
  required: ['agent_id', 'updates', 'change_summary'],
  agentScoped: true,
  schema: z.object({ agent_id: idSchema, updates: agentUpdatesSchema, change_summary: changeSummary }).strict(),
  summarize: (args) => `Update agent ${args.agent_id} (${Object.keys(args.updates).join(', ')}): ${args.change_summary}`,
});

/** A write whose only argument is the agent (enable / disable / run now). */
function agentAction(
  name: 'enable_agent' | 'disable_agent' | 'run_agent',
  description: string,
  verb: string,
): ClientToolDefinition {
  return defineClientTool({
    name,
    pack: 'agents',
    description,
    properties: { agent_id: AGENT_ID },
    required: ['agent_id'],
    agentScoped: true,
    schema: z.object({ agent_id: idSchema }).strict(),
    summarize: (args) => `${verb} agent ${args.agent_id}${name === 'run_agent' ? ' now' : ''}.`,
  });
}

const enableAgent = agentAction(
  'enable_agent',
  'Enable an autonomous agent (admin): from now on its triggers wake it (at most '
    + `${AGENT_LIMITS.maxScheduledRunsPerDay} scheduled runs per day, within its budget).`,
  'Enable',
);

const disableAgent = agentAction(
  'disable_agent',
  'Disable an autonomous agent (admin): no new runs start; a run in flight finishes.',
  'Disable',
);

const runAgent = agentAction(
  'run_agent',
  'Start a manual run of an agent now ("Run now"). Not counted against the daily scheduled-run limit; '
    + 'refused while another run of the same agent is active. Track it with list_agent_runs / get_agent_run.',
  'Run',
);

const cancelAgentRun = defineClientTool({
  name: 'cancel_agent_run',
  pack: 'agents',
  description: 'Cancel a queued or running agent run; work already written to its project stays.',
  properties: { agent_id: AGENT_ID, run_id: idProperty('Run id (ar_…).') },
  required: ['agent_id', 'run_id'],
  agentScoped: true,
  schema: z.object({ agent_id: idSchema, run_id: idSchema }).strict(),
  summarize: (args) => `Cancel run ${args.run_id} of agent ${args.agent_id}.`,
});

const createWorkflow = defineClientTool({
  name: 'create_workflow',
  pack: 'agents',
  description: 'Save a NEW workflow (admin) from a complete definition that validate_workflow reported valid. '
    + 'To give it to an agent, propose update_agent with the new workflow_id afterwards.',
  properties: { definition: WORKFLOW_DEFINITION_PROPERTY },
  required: ['definition'],
  schema: z.object({ definition: workflowDefinitionSchema }).strict(),
  summarize: (args) => `Create workflow ${q(args.definition.name)} (${args.definition.nodes.length} nodes, `
    + `${args.definition.edges.length} edges).`,
});

const updateWorkflow = defineClientTool({
  name: 'update_workflow',
  pack: 'agents',
  description: 'Save a new revision of a workflow (admin). Send the COMPLETE new definition (never a partial one), '
    + 'built from get_workflow and checked with validate_workflow, plus expected_revision = the revision you read; '
    + 'a newer revision saved meanwhile makes it fail, then re-read and rebuild. The card shows the added, removed '
    + 'and changed nodes and edges. Agents using it run the new revision from their next run.',
  properties: {
    workflow_id: WORKFLOW_ID,
    expected_revision: { type: 'integer', minimum: 1, description: 'The current revision you read with get_workflow.' },
    definition: WORKFLOW_DEFINITION_PROPERTY,
    change_summary: stringProperty('One-line description of the change, shown to the user.', MAX_CHANGE_SUMMARY),
  },
  required: ['workflow_id', 'expected_revision', 'definition', 'change_summary'],
  schema: z.object({
    workflow_id: idSchema,
    expected_revision: z.number().int().min(1),
    definition: workflowDefinitionSchema,
    change_summary: changeSummary,
  }).strict(),
  summarize: (args) => `Update workflow ${args.workflow_id} (revision ${args.expected_revision} → ${args.expected_revision + 1}): ${args.change_summary}`,
});

const duplicateWorkflow = defineClientTool({
  name: 'duplicate_workflow',
  pack: 'agents',
  description: 'Copy a workflow into a new one (admin), e.g. to change a template without touching agents that '
    + 'use the original. The copy records where it was derived from.',
  properties: {
    workflow_id: WORKFLOW_ID,
    name: stringProperty('Name of the copy (default: "<name> (copy)").', WORKFLOW_LIMITS.maxNameChars),
  },
  required: ['workflow_id'],
  schema: z.object({ workflow_id: idSchema, name: z.string().trim().min(1).max(WORKFLOW_LIMITS.maxNameChars).optional() }).strict(),
  summarize: (args) => (args.name === undefined
    ? `Duplicate workflow ${args.workflow_id}.`
    : `Duplicate workflow ${args.workflow_id} as ${q(args.name)}.`),
});

export function createAgentsClientTools(): ClientToolDefinition[] {
  return [
    createAgent,
    updateAgent,
    enableAgent,
    disableAgent,
    runAgent,
    cancelAgentRun,
    createWorkflow,
    updateWorkflow,
    duplicateWorkflow,
  ];
}
