/**
 * @fileoverview The saved Understand flow a knowledge refresh starts (`propose_knowledge_refresh`), read with the
 * signed-in person's own session: an active engineering flow whose steps are the "Understand the repository"
 * template's (each step's id and kind, an agent step's role, and the arrows between them; its names, positions, map
 * cap and budget are the administrator's to change). A saved flow records no template id, so its steps are what make
 * it the Understand flow; with several, the one saved last. The card and its executor both read it, the executor
 * again at the click, so Approve starts the flow (and revision) the card showed or nothing.
 *
 * @module assistant/approvals/understandFlow
 */
import { MAX_SHARD_CAP } from '@stream/assistant/tools/knowledge-refresh-rules'
import { findEngineeringTemplate } from '../../api/engineeringTemplates'
import { workflowsApi } from '../../api/workflowsApi'
import { isRecord } from '../../lib/typeGuards'
import type { WorkflowDefinition, WorkflowSummary } from '../../api/workflowsApi'

export interface UnderstandFlow {
  workflowId: string
  name: string
  revision: number
  /** The map step's most shards in a run (its `shard_cap`, else the map step's default). */
  shardCap: number
  /** Its agent steps, each an agent session of its own. */
  agentSteps: number
  monthlyBudgetUsd: number | null
}

/** The Understand flow's template (lambda/shared/engineering_flow_templates.json). */
export const UNDERSTAND_TEMPLATE_ID = 'understand-repository'

/** The react-query key (under the workflows' own, so their invalidations cover it). */
export const understandFlowKey = ['workflows', 'understand-flow'] as const

const agentRoleParam = (params: unknown): string => (isRecord(params) && typeof params.role === 'string' ? params.role : '')

/** A definition's steps as they make it one flow or another, in a stable order. */
function stepsOf(definition: WorkflowDefinition): string {
  const nodes = definition.nodes.map((node) => `${node.id}:${node.type}:${agentRoleParam(node.data.params) || (node.data.role ?? '')}`)
  const edges = definition.edges.map((edge) => `${edge.source}>${edge.target}`)
  const sorted = (items: readonly string[]) => [...items].sort((a, b) => a.localeCompare(b))
  return JSON.stringify([sorted(nodes), sorted(edges)])
}

const template = findEngineeringTemplate(UNDERSTAND_TEMPLATE_ID)
const TEMPLATE_STEPS = template === undefined ? null : stepsOf(template.definition)

/** The map step's cap, as the server reads it (a whole number from 1 to the most, else the most). */
function shardCapOf(definition: WorkflowDefinition): number {
  const map = definition.nodes.find((node) => node.type === 'map')
  const cap = isRecord(map?.data.params) ? map.data.params.shard_cap : undefined
  return typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= MAX_SHARD_CAP ? cap : MAX_SHARD_CAP
}

/** Whether `definition` has the Understand template's steps. */
const isUnderstandFlow =(definition: WorkflowDefinition | null): definition is WorkflowDefinition =>
  definition !== null && TEMPLATE_STEPS !== null && stepsOf(definition) === TEMPLATE_STEPS

const savedLastFirst = (a: WorkflowSummary, b: WorkflowSummary): number =>
  (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || a.workflow_id.localeCompare(b.workflow_id)

/** The saved Understand flow, or null when none is saved. A read that fails throws (the card holds Approve). */
export async function findUnderstandFlow(): Promise<UnderstandFlow | null> {
  const flows = (await workflowsApi.list())
    .filter((flow) => flow.kind === 'engineering' && flow.status === 'active')
    .sort(savedLastFirst)
  for (const flow of flows) {
    const { workflow } = await workflowsApi.get(flow.workflow_id)
    if (isUnderstandFlow(workflow.definition)) {
      return {
        workflowId: workflow.workflow_id, name: workflow.name, revision: workflow.revision,
        shardCap: shardCapOf(workflow.definition),
        agentSteps: workflow.definition.nodes.filter((node) => node.type === 'agent').length, monthlyBudgetUsd: workflow.monthly_budget_usd,
      }
    }
  }
  return null
}
