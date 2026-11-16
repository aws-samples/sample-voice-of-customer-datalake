/**
 * @fileoverview The agent form's draft: the editable fields of an {@link Agent}
 * as the API body takes them, the fields that differ from the stored agent
 * (PUT sends only those), and the Zod check of that body, answered as plain
 * translated messages.
 *
 * @module pages/Agents/agentDraft
 */
import {
  agentFormSchema, API_AGENT_LIMITS, API_ENGINEERING_LIMITS, ENGINEERING_TRIGGER_KINDS, engineeringAgentFormSchema, TRIGGER_KINDS,
} from '../../api/agentsApi'
import type { Agent, AgentForm, AgentTrigger } from '../../api/agentsApi'

/** The draft the form edits: an engineering agent's `engineering` settings are set up on their own card
 *  (AgentEngineering.tsx), never through the draft. */
export type AgentDraft = Omit<AgentForm, 'workflow_id' | 'engineering'> & { workflow_id: string | null }

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

/** An engineering agent's own message for its shorter instructions. */
const ENGINEERING_INSTRUCTIONS: DraftProblem = {
  key: 'validation.instructions', values: { max: API_ENGINEERING_LIMITS.maxInstructionsChars },
}

/**
 * The PUT body when valid, else what to fix — one plain message per field, never Zod's wording. An engineering agent
 * (``engineering``) is held to its own bounds and may have a ``github_issue`` trigger.
 */
export function checkUpdate(changes: Partial<AgentDraft>, engineering = false):
  { body: Partial<AgentForm> } | { errors: DraftProblem[] } {
  const { workflow_id: workflowId, ...rest } = changes
  const candidate = workflowId === null || workflowId === undefined ? rest : { ...rest, workflow_id: workflowId }
  const parsed = (engineering ? engineeringAgentFormSchema : agentFormSchema).partial().safeParse(candidate)
  if (parsed.success) return { body: parsed.data }
  const problems = parsed.error.issues.map((issue) => {
    const field = String(issue.path[0])
    if (engineering && field === 'instructions') return ENGINEERING_INSTRUCTIONS
    return FIELD_PROBLEMS[field] ?? OTHER_PROBLEM
  })
  return { errors: [...new Set(problems)] }
}

/** Whether a draft's scope names sources: a threshold trigger counts every source, so it is not offered then. */
export const scopesSources = (draft: Pick<AgentDraft, 'scope'>): boolean => (draft.scope.sources ?? []).length > 0

/** The trigger kinds an agent may add: an engineering agent's (one GitHub issue trigger at most), and no threshold
 *  while the scope names sources (its counters count every source). */
export function addableKinds(draft: Pick<AgentDraft, 'scope' | 'triggers'>, engineering: boolean):
  readonly AgentTrigger['kind'][] {
  const kinds: readonly AgentTrigger['kind'][] = engineering ? ENGINEERING_TRIGGER_KINDS : TRIGGER_KINDS
  const hasIssue = draft.triggers.some((trigger) => trigger.kind === 'github_issue')
  return kinds.filter((kind) => !(kind === 'github_issue' && hasIssue) && !(kind === 'threshold' && scopesSources(draft)))
}

/** A whole number clamped to [min, max]; blank / NaN keeps the fallback. */
export function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && value.trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback
}
