/**
 * @fileoverview Argument schemas of the `agents` pack write tools — a strict
 * mirror of `lambda/stream/src/assistant/tools/{agent-schemas.ts,client/agents.ts}`
 * (same keys, enums and limits: the limits are the stream's own, imported from
 * `@stream/assistant/tools/agent-limits`).
 *
 * The shapes are built by the same builders the editor and the agent form use
 * (`api/workflowsApi.ts`, `api/agentsApi.ts`), fed the STREAM's limits: the SPA
 * must accept exactly what the server proposes, and the agents Lambda remains
 * the judge of its own (stricter) limits when the write lands.
 *
 * @module assistant/approvals/agentSchemas
 */
import { z } from 'zod'
import { AGENT_BUDGET_RULES, AGENT_LIMITS, WORKFLOW_LIMITS } from '@stream/assistant/tools/agent-limits'
import { buildAgentFieldsShape } from '../../api/agentsApi'
import { buildWorkflowDefinitionSchema } from '../../api/workflowsApi'
import { hasAnyKey, idSchema, nonEmpty } from './schemas'
import type { AgentLimits } from '../../api/agentsApi'
import type { WorkflowLimits } from '../../api/workflowsApi'

/** The stream's `WORKFLOW_LIMITS` (`@stream/assistant/tools/agent-limits`). */
const STREAM_WORKFLOW_LIMITS: WorkflowLimits = WORKFLOW_LIMITS

/**
 * The stream's `AGENT_LIMITS` and budget rules. Its budget schema never takes a null monthly
 * cap (pinned by the stream's agent-schemas.test.ts and by agentSchemas.test.ts here).
 */
const STREAM_AGENT_LIMITS: AgentLimits = { ...AGENT_LIMITS, ...AGENT_BUDGET_RULES, monthlyCapNullable: false }

const MAX_CHANGE_SUMMARY = 500
const changeSummary = nonEmpty(MAX_CHANGE_SUMMARY)

const approvalWorkflowDefinitionSchema = buildWorkflowDefinitionSchema(STREAM_WORKFLOW_LIMITS, idSchema)

const agentFields = buildAgentFieldsShape(STREAM_AGENT_LIMITS, idSchema)

export const createAgentArgs = z.strictObject(agentFields).partial().required({ name: true, scope: true })

const agentUpdatesSchema = z.strictObject(agentFields).partial()
  .refine(hasAnyKey, 'updates must change at least one field')

export const updateAgentArgs = z.strictObject({
  agent_id: idSchema,
  updates: agentUpdatesSchema,
  change_summary: changeSummary,
})

/** enable_agent / disable_agent / run_agent. */
export const agentActionArgs = z.strictObject({ agent_id: idSchema })

export const cancelAgentRunArgs = z.strictObject({ agent_id: idSchema, run_id: idSchema })

export const createWorkflowArgs = z.strictObject({ definition: approvalWorkflowDefinitionSchema })

export const updateWorkflowArgs = z.strictObject({
  workflow_id: idSchema,
  expected_revision: z.number().int().min(1),
  definition: approvalWorkflowDefinitionSchema,
  change_summary: changeSummary,
})

export const duplicateWorkflowArgs = z.strictObject({
  workflow_id: idSchema,
  name: nonEmpty(STREAM_WORKFLOW_LIMITS.maxNameChars).optional(),
})

export type CreateAgentArgs = z.infer<typeof createAgentArgs>
export type UpdateAgentArgs = z.infer<typeof updateAgentArgs>
export type AgentActionArgs = z.infer<typeof agentActionArgs>
export type CancelAgentRunArgs = z.infer<typeof cancelAgentRunArgs>
export type CreateWorkflowArgs = z.infer<typeof createWorkflowArgs>
export type UpdateWorkflowArgs = z.infer<typeof updateWorkflowArgs>
export type DuplicateWorkflowArgs = z.infer<typeof duplicateWorkflowArgs>
