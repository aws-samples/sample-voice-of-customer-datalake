/**
 * A throwaway, e2e-named agent for the specs that need an agent page with a Save
 * bar (assistant-bubble, unsaved-guard). Created through the API as e2e-admin,
 * recorded in the ledger the moment its id is known, and archived by the spec
 * that created it (`DELETE /agents/{id}` archives; agents have no hard delete).
 *
 * It points at the built-in workflow (`wf_default`) so creating it does not
 * also create a workflow copy: workflows have no delete route.
 */
import { apiCall } from './api'
import { BUILTIN_WORKFLOW_ID, RUN_PREFIX } from './env'
import { isRecord } from './guards'
import { recordCreated } from './ledger'

export interface E2eAgent {
  readonly id: string
  readonly name: string
}

/** The `{agent: {...}}` envelope's string field, or undefined. */
function agentField(body: unknown, field: string): string | undefined {
  const agent = isRecord(body) && isRecord(body['agent']) ? body['agent'] : undefined
  const value = agent === undefined ? undefined : agent[field]
  return typeof value === 'string' ? value : undefined
}

/** Create a disabled agent named `${RUN_PREFIX}${suffix}` (admin only). */
export async function createE2eAgent(suffix: string): Promise<E2eAgent> {
  const name = `${RUN_PREFIX}${suffix}`
  const res = await apiCall('admin', 'POST', '/agents', {
    name,
    description: 'Created by the e2e QA suite; archived at the end of the spec.',
    workflow_id: BUILTIN_WORKFLOW_ID,
    triggers: [],
  })
  const id = agentField(res.body, 'agent_id')
  if (res.status !== 201 || id === undefined) throw new Error(`POST /agents -> ${res.status}`)
  recordCreated('agent', id, name)
  return { id, name }
}

/** The agent's current name as the API returns it (admin read). */
export async function agentName(id: string): Promise<string | undefined> {
  return agentField((await apiCall('admin', 'GET', `/agents/${encodeURIComponent(id)}`)).body, 'name')
}

/** Archive it (idempotent enough for an afterAll: a second archive is a 404/409, not an error here). */
export async function archiveE2eAgent(agent: E2eAgent | undefined): Promise<number | undefined> {
  if (agent === undefined || !agent.name.startsWith(RUN_PREFIX)) return undefined
  return (await apiCall('admin', 'DELETE', `/agents/${encodeURIComponent(agent.id)}`)).status
}
