/**
 * What an autonomous-agent run created, read from its journal, and put in the
 * ledger so cleanup deletes it whatever the run did.
 *
 * QA 3.00.00 S1: s2 ran an agent on the BUILT-IN workflow by accident, and its
 * `select_or_create_project` node created a project the model had named
 * ("Zebrafin Aquarium Hub Reliability"). No e2e name, no ledger entry, so
 * nothing cleaned it up. The runtime always journals a creation the same way
 * (`lambda/agents/nodes/select_or_create_project.py` → conductor
 * `_record_result`): a `node_finished` event whose summary is
 * `Created project {id} for category …` and whose `ref.project_id` is that id.
 * A REUSED project (summary `Reusing project {id}: …`) belongs to someone else.
 * It is never recorded, so cleanup can never delete it. It is returned so the
 * spec can fail on it instead.
 */
import { apiCall, listOf } from './api'
import { RUN_PREFIX } from './env'
import { isRecord } from './guards'
import { recordCreated } from './ledger'

/** One journal event, as `GET /agents/{id}/runs/{run_id}/events` answers it (lenient). */
export interface JournalEvent {
  readonly kind: string
  readonly summary: string
  readonly refProjectId: string | null
}

/** A journal item as a `JournalEvent` (unknown shapes read as empty fields). */
export function journalEventOf(item: unknown): JournalEvent {
  const record = isRecord(item) ? item : {}
  const ref = isRecord(record['ref']) ? record['ref'] : {}
  const projectId = ref['project_id']
  return {
    kind: typeof record['kind'] === 'string' ? record['kind'] : '',
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    refProjectId: typeof projectId === 'string' && projectId !== '' ? projectId : null,
  }
}

const CREATED = /^Created project (\S+)/
const REUSED = /^Reusing project (\S+?):/

/** The projects a run's journal says it created and reused, each id once. */
export function runProjects(events: readonly JournalEvent[]): { created: string[]; reused: string[] } {
  const created = new Set<string>()
  const reused = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'node_finished' || event.refProjectId === null) continue
    // The summary and the ref must name the same project: either alone could be model text.
    if (CREATED.exec(event.summary)?.[1] === event.refProjectId) created.add(event.refProjectId)
    else if (REUSED.exec(event.summary)?.[1] === event.refProjectId) reused.add(event.refProjectId)
  }
  return { created: [...created], reused: [...reused] }
}

/** The ledger label of a project a run created: the project's own name is the model's. */
export const runProjectLabel = (runId: string): string => `${RUN_PREFIX}agent-run-${runId}-project`

/**
 * The only step types an e2e run may execute: they read feedback and call the
 * model, and none of them selects, creates or writes a project (a project step
 * could pick a REAL project and write into it).
 */
export const SAFE_RUN_STEP_TYPES: readonly string[] = ['start', 'aggregate_reviews', 'custom_llm', 'end']

/** What a run must be about to execute: the agent's workflow, by id and by its e2e name. */
export interface RunTarget {
  readonly workflowId: string
  readonly workflowName: string
}

/**
 * Why an agent must NOT be run yet, read from `GET /agents/{id}` and `GET
 * /workflows/{id}` bodies (empty = safe to run). QA 3.00.00 S1: the editor save
 * never landed, the agent still ran its built-in template copy, and that run
 * created a project. Checked before every Run now.
 */
export function runTargetProblems(agentBody: unknown, workflowBody: unknown, target: RunTarget): string[] {
  const agent = isRecord(agentBody) && isRecord(agentBody['agent']) ? agentBody['agent'] : {}
  const workflow = isRecord(workflowBody) && isRecord(workflowBody['workflow']) ? workflowBody['workflow'] : {}
  const definition = isRecord(workflow['definition']) ? workflow['definition'] : {}
  const nodes = Array.isArray(definition['nodes']) ? definition['nodes'].filter(isRecord) : []
  const problems: string[] = []
  if (agent['workflow_id'] !== target.workflowId) problems.push(`the agent runs workflow ${String(agent['workflow_id'])}, not ${target.workflowId}`)
  if (workflow['workflow_id'] !== target.workflowId) problems.push(`GET /workflows/{id} answered workflow ${String(workflow['workflow_id'])}`)
  if (definition['name'] !== target.workflowName) problems.push(`the workflow is named ${JSON.stringify(definition['name'])}, not ${target.workflowName}: the save did not land`)
  if (nodes.length === 0) problems.push('the workflow has no steps')
  const unsafe = nodes.map((n) => String(n['type'])).filter((type) => !SAFE_RUN_STEP_TYPES.includes(type))
  if (unsafe.length > 0) problems.push(`steps a run must not execute: ${[...new Set(unsafe)].join(', ')}`)
  return problems
}

/** The events route's page cap (agents_handler.py MAX_EVENTS_PAGE), and a bound on pages read. */
const EVENTS_PAGE = 200
const MAX_PAGES = 50

/** Every journal event of one run (admin read, paged). */
export async function runJournal(agentId: string, runId: string): Promise<JournalEvent[]> {
  const events: JournalEvent[] = []
  let after = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await apiCall('admin', 'GET', `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${EVENTS_PAGE}`)
    if (res.status !== 200) throw new Error(`GET /agents/{id}/runs/{run_id}/events -> ${res.status}`)
    const items = listOf(res.body, 'items')
    events.push(...items.map(journalEventOf))
    const next = isRecord(res.body) ? res.body['next_after'] : undefined
    if (items.length === 0 || typeof next !== 'number' || next <= after) break
    after = next
  }
  return events
}

/**
 * Records every project the run created in the ledger (cleanup deletes it) and
 * returns what it found. Call it after a run is terminal, AND in cleanup:
 * recording is idempotent, and a run cut short still journals what it did.
 */
export async function recordRunProjects(agentId: string, runId: string): Promise<{ created: string[]; reused: string[] }> {
  const found = runProjects(await runJournal(agentId, runId))
  for (const id of found.created) recordCreated('project', id, runProjectLabel(runId))
  return found
}
