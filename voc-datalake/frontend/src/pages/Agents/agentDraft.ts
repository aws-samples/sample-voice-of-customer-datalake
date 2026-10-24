/**
 * @fileoverview The agent form's draft: the editable fields of an {@link Agent}
 * as the API body takes them, the fields that differ from the stored agent
 * (PUT sends only those), and the Zod check of that body.
 *
 * @module pages/Agents/agentDraft
 */
import { agentFormSchema } from '../../api/agentsApi'
import type { Agent, AgentForm } from '../../api/agentsApi'

export type AgentDraft = Omit<AgentForm, 'workflow_id'> & { workflow_id: string | null }

export function draftOf(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    scope: agent.scope,
    instructions: agent.instructions,
    personas: agent.personas,
    triggers: agent.triggers,
    models: agent.models,
    output: agent.output,
    workflow_id: agent.workflow_id,
    budget: agent.budget,
  }
}

/** Every editable field of the draft (what PUT may send). */
export const DRAFT_KEYS = [
  'name', 'description', 'scope', 'instructions', 'personas', 'triggers', 'models', 'output', 'workflow_id', 'budget',
] as const satisfies readonly (keyof AgentDraft)[]

/** The draft's fields whose value differs from the stored agent's. */
export function changedFields(agent: Agent, draft: AgentDraft): Partial<AgentDraft> {
  const stored = draftOf(agent)
  const changed: Partial<AgentDraft> = {}
  for (const key of DRAFT_KEYS) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(draft[key])) Object.assign(changed, { [key]: draft[key] })
  }
  return changed
}

/** The PUT body when valid, else the first problems (path: message). */
export function checkUpdate(changes: Partial<AgentDraft>): { body: Partial<AgentForm> } | { errors: string[] } {
  const { workflow_id: workflowId, ...rest } = changes
  const candidate = workflowId === null || workflowId === undefined ? rest : { ...rest, workflow_id: workflowId }
  const parsed = agentFormSchema.partial().safeParse(candidate)
  if (parsed.success) return { body: parsed.data }
  return { errors: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }
}

/** A whole number clamped to [min, max]; blank / NaN keeps the fallback. */
export function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && value.trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback
}
