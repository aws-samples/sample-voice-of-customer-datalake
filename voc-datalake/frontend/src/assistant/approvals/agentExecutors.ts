/**
 * @fileoverview REST executors for the `agents` pack write tools, through the
 * agents / workflows API clients (the user's own token; the agents Lambda
 * enforces admin-only and its own limits). A stale `update_workflow`
 * (`expected_revision` behind the stored one, 409) is reported to the model so
 * it re-reads and rebuilds instead of retrying blindly.
 *
 * @module assistant/approvals/agentExecutors
 */
import { agentsApi } from '../../api/agentsApi'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { workflowsApi } from '../../api/workflowsApi'
import { invalidateKeys, keysFor } from './invalidation'
import { StaleApprovalError } from './shown'
import type { WriteToolExecutionContext } from '../types'
import type {
  AgentActionArgs, CancelAgentRunArgs, CreateAgentArgs, CreateWorkflowArgs, DuplicateWorkflowArgs, UpdateAgentArgs,
  UpdateWorkflowArgs,
} from './agentSchemas'

export const STALE_WORKFLOW_MESSAGE = 'A newer revision of this workflow was saved since you read it; nothing was saved. '
  + 'Read it again with get_workflow, rebuild the change on top of it and propose update_workflow with the new revision.'

export async function createAgent(args: CreateAgentArgs, ctx: WriteToolExecutionContext) {
  const agent = await agentsApi.create(args)
  void invalidateKeys(ctx.queryClient, keysFor.agents())
  return { summary: `Created agent "${agent.name}" (${agent.agent_id}), disabled.`, data: { agent_id: agent.agent_id } }
}

export async function updateAgent(args: UpdateAgentArgs, ctx: WriteToolExecutionContext) {
  await agentsApi.update(args.agent_id, args.updates)
  void invalidateKeys(ctx.queryClient, keysFor.agent(args.agent_id))
  return { summary: `Updated agent ${args.agent_id} (${Object.keys(args.updates).join(', ')}): ${args.change_summary}` }
}

export async function enableAgent(args: AgentActionArgs, ctx: WriteToolExecutionContext) {
  await agentsApi.enable(args.agent_id)
  void invalidateKeys(ctx.queryClient, keysFor.agent(args.agent_id))
  return { summary: `Enabled agent ${args.agent_id}; its triggers now wake it.` }
}

export async function disableAgent(args: AgentActionArgs, ctx: WriteToolExecutionContext) {
  await agentsApi.disable(args.agent_id)
  void invalidateKeys(ctx.queryClient, keysFor.agent(args.agent_id))
  return { summary: `Disabled agent ${args.agent_id}; no new runs start (a run in flight finishes).` }
}

export async function runAgent(args: AgentActionArgs, ctx: WriteToolExecutionContext) {
  try {
    const run = await agentsApi.run(args.agent_id)
    void invalidateKeys(ctx.queryClient, keysFor.agent(args.agent_id))
    return { summary: `Started run ${run.run_id} of agent ${args.agent_id}; follow it in the agent's Runs tab.`, data: { run_id: run.run_id } }
  } catch (error) {
    if (apiErrorStatus(error) === 409) throw new StaleApprovalError(`Agent ${args.agent_id} already has a run in progress; nothing was started.`)
    throw error
  }
}

export async function cancelAgentRun(args: CancelAgentRunArgs, ctx: WriteToolExecutionContext) {
  const run = await agentsApi.cancelRun(args.agent_id, args.run_id)
  void invalidateKeys(ctx.queryClient, keysFor.agent(args.agent_id))
  return { summary: `Run ${args.run_id} is now ${run.status}; work already written to its project stays.` }
}

export async function createWorkflow(args: CreateWorkflowArgs, ctx: WriteToolExecutionContext) {
  const view = await workflowsApi.create(args.definition)
  void invalidateKeys(ctx.queryClient, keysFor.workflows())
  return { summary: `Created workflow "${view.name}" (${view.workflow_id}, revision ${view.revision}).`, data: { workflow_id: view.workflow_id } }
}

export async function updateWorkflow(args: UpdateWorkflowArgs, ctx: WriteToolExecutionContext) {
  try {
    const view = await workflowsApi.save(args.workflow_id, args.definition, args.expected_revision)
    void invalidateKeys(ctx.queryClient, keysFor.workflows())
    return { summary: `Saved workflow ${args.workflow_id} as revision ${view.revision}: ${args.change_summary}`, data: { revision: view.revision } }
  } catch (error) {
    if (apiErrorStatus(error) === 409) throw new StaleApprovalError(STALE_WORKFLOW_MESSAGE)
    throw error
  }
}

export async function duplicateWorkflow(args: DuplicateWorkflowArgs, ctx: WriteToolExecutionContext) {
  const view = await workflowsApi.duplicate(args.workflow_id, args.name)
  void invalidateKeys(ctx.queryClient, keysFor.workflows())
  return { summary: `Copied workflow ${args.workflow_id} to "${view.name}" (${view.workflow_id}).`, data: { workflow_id: view.workflow_id } }
}
