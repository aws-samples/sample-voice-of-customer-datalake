/**
 * @fileoverview The agent form's draft: the editable fields of an {@link Agent}
 * as the API body takes them, the fields that differ from the stored agent
 * (PUT sends only those), and the Zod check of that body, answered as plain
 * translated messages.
 *
 * @module pages/Agents/agentDraft
 */
import { agentFormSchema, API_AGENT_LIMITS } from '../../api/agentsApi'
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

/** One problem with the draft, as a translation key of the `agents` namespace and its values. */
export interface DraftProblem {
  readonly key: string
  readonly values?: Readonly<Record<string, number>>
}

/** The plain message for each field (`validation.*` in agents.json), with the limit it names. */
const FIELD_PROBLEMS: Readonly<Record<string, DraftProblem>> = {
  scope: { key: 'validation.scope' },
  name: { key: 'validation.name', values: { max: API_AGENT_LIMITS.maxNameChars } },
  description: { key: 'validation.description', values: { max: API_AGENT_LIMITS.maxDescriptionChars } },
  instructions: { key: 'validation.instructions', values: { max: API_AGENT_LIMITS.maxInstructionsChars } },
  triggers: { key: 'validation.triggers' },
  personas: { key: 'validation.personas', values: { max: API_AGENT_LIMITS.maxFixedPersonas } },
  models: { key: 'validation.models' },
  workflow_id: { key: 'validation.workflow' },
  budget: { key: 'validation.budget' },
}
const OTHER_PROBLEM: DraftProblem = { key: 'validation.other' }

/** The PUT body when valid, else what to fix — one plain message per field, never Zod's wording. */
export function checkUpdate(changes: Partial<AgentDraft>): { body: Partial<AgentForm> } | { errors: DraftProblem[] } {
  const { workflow_id: workflowId, ...rest } = changes
  const candidate = workflowId === null || workflowId === undefined ? rest : { ...rest, workflow_id: workflowId }
  const parsed = agentFormSchema.partial().safeParse(candidate)
  if (parsed.success) return { body: parsed.data }
  const problems = parsed.error.issues.map((issue) => FIELD_PROBLEMS[String(issue.path[0])] ?? OTHER_PROBLEM)
  return { errors: [...new Set(problems)] }
}

/** A whole number clamped to [min, max]; blank / NaN keeps the fallback. */
export function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && value.trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback
}
