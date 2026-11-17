/**
 * @fileoverview The run workspace's reads and actions (7.51.00, the Agents API's run workspace routes;
 * docs/autonomous-agents.md "The run workspace"): an agent's thread a page at a time and one item of it whole, its
 * changes (from its patches in S3) and one file's part of a patch, the files its tool calls touched, its gate, what
 * its brief recalled and what Learn made of its task; the run's assertions; the list of runs; a person's steering
 * (to the orchestrator, never to an agent) and an ended run's restart as a child run. The overview's own new fields
 * (lanes, gates, cost, parent and children) are read with the overview (api/engineeringRunsApi.ts).
 *
 * Every read is lenient like the run monitor's: a bad entry costs itself, an unknown kind or status is kept as text.
 *
 * @module api/engineeringRunWorkspaceApi
 */
import { z } from 'zod'
import { post } from './requestKit'
import { fetchApi } from './client'
import { eachOf } from './lenientFields'
import type { CursorPage } from './cursorPage'

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)
const count = z.number().catch(0)
const maybeNumber = z.number().nullable().catch(null)
const flag = z.boolean().catch(false)

/** The statuses a run is listed in (the runs list route's own), the Runs list's filter. */
export const RUN_LIST_STATUSES = ['active', 'needs_human', 'done', 'failed', 'stopped'] as const
/** The ways an ended run starts again as a child run: from its agents' checkpoints, or their tasks afresh. */
export const RESTART_MODES = ['resume', 'restart'] as const
export type RestartMode = (typeof RESTART_MODES)[number]
/** The commit a child run starts on: the run's own, or the repository's head now. */
export const RESTART_BASES = ['same', 'head'] as const
export type RestartBase = (typeof RESTART_BASES)[number]
/** The most a page of a thread holds (the thread route's own limit). */
export const THREAD_PAGE = 200

/** A tool call on one line: its name, whether it worked (null: no result yet), a one-line input, ACP kind and status. */
const ToolSchema = z.object({ name: text, ok: z.boolean().nullable().catch(null), input: text, kind: text, status: text })

/**
 * One item of an agent's thread (the thread view's): `ref` is its identity (`<attempt>.<chunk>.<offset>[.1]` for a
 * transcript event, `c<seq>` for a conversation message); `update` the ACP update kind it came as.
 */
const ThreadItemSchema = z.object({
  ref: z.string().min(1),
  at: text,
  kind: text,
  from: z.object({ kind: text, id: text }).catch({ kind: '', id: '' }),
  text,
  cut: flag,
  update: text,
  tool: ToolSchema.nullable().catch(null).optional().transform((tool) => tool ?? null),
})
export type ThreadItem = z.output<typeof ThreadItemSchema>

const ThreadPageSchema = z.object({ items: eachOf(ThreadItemSchema), next: maybeText, done: flag })
export type ThreadPage = z.output<typeof ThreadPageSchema>

/** One item whole: its event and, for a tool call, its result (each the transcript's own record, shown as data). */
const ThreadEventSchema = z.object({ event: z.unknown(), result: z.unknown().optional().transform((r) => r ?? null) })
export type ThreadEvent = z.output<typeof ThreadEventSchema>

const ChangedFileSchema = z.object({
  path: z.string().min(1), old_path: z.string().optional().catch(undefined), status: text,
  additions: count, deletions: count, binary: flag,
})
export type ChangedFile = z.output<typeof ChangedFileSchema>
const PatchSchema = z.object({ key: z.string().min(1), source: text, at: text, size: count })

/** An agent's changes: one of its patches (`key` null for none), parsed into files, and the run's links on its host. */
const ChangesSchema = z.object({
  source: text, key: maybeText, commit: maybeText, attempt: count,
  files: eachOf(ChangedFileSchema), truncated: flag, patches: eachOf(PatchSchema),
  pr_url: maybeText.optional().transform((url) => url ?? null),
  commit_url: maybeText.optional().transform((url) => url ?? null),
})
export type AgentChanges = z.output<typeof ChangesSchema>
const FilePatchSchema = z.object({ path: text, patch: z.string(), truncated: flag })
export type FilePatch = z.output<typeof FilePatchSchema>

const TouchedFileSchema = z.object({ path: z.string().min(1), read: count, written: count, listed: count, last_at: text })
export type TouchedFile = z.output<typeof TouchedFileSchema>
const FilesSchema = z.object({ files: eachOf(TouchedFileSchema), truncated: flag })
export type AgentFiles = z.output<typeof FilesSchema>

const GateCheckSchema = z.object({
  key: text, name: text, status: text, reason: text, exit_code: maybeNumber, duration_s: maybeNumber, output_tail: text,
})
export type GateCheck = z.output<typeof GateCheckSchema>
const FindingSchema = z.object({
  id: text, reviewer: text, severity: text, title: text, file: text, line: maybeNumber, outcome: text, outcome_note: text,
})
export type GateFinding = z.output<typeof FindingSchema>
/** The agent's gate: its record (`voc-gate-record/1`: the verdict and the reviewers' findings) and its last run's checks. */
const GateSchema = z.object({
  record: z.object({ verdict: text, stop_reason: text, findings: eachOf(FindingSchema) }).nullable().catch(null),
  checks: eachOf(GateCheckSchema), passed: z.boolean().nullable().catch(null), ran_at: maybeText,
})
export type AgentGate = z.output<typeof GateSchema>

const RecalledSchema = z.object({ name: text, text })
const LearnedSchema = z.object({
  key: z.string().min(1), lesson: text, coach: text, proposed_version: maybeNumber, at: maybeText,
})
const MemorySchema = z.object({ recalled: eachOf(RecalledSchema), learned: eachOf(LearnedSchema) })
export type AgentMemory = z.output<typeof MemorySchema>

/** One step's assertion and what was recorded of it (`pending` before a record). */
const AssertionSchema = z.object({
  step: text, check: z.string().min(1), on_fail: text, status: text, detail: text, attempt: count, at: maybeText,
})
export type RunAssertion = z.output<typeof AssertionSchema>

const ListedRunSchema = z.object({
  run_id: z.string().min(1), flow: text, goal: text, status: text, started_at: maybeText, ended_at: maybeText,
  cost_usd: maybeNumber, parent: z.object({ run_id: z.string().min(1), mode: text }).nullable().catch(null),
})
export type ListedRun = z.output<typeof ListedRunSchema>
const RunsPageSchema = z.object({ runs: eachOf(ListedRunSchema), next: maybeText })

/** The Runs list's filters (each '' for none: this month, every flow, every status). */
export interface RunsQuery {
  month: string
  flow: string
  status: string
}

/** A person's steering: to the run's orchestrator, optionally about one of its agents (at most 1 KB with it). */
export interface SteerRequest {
  text: string
  about?: string
}

/** An ended run started again as a child run (`agents` none: every unfinished task's). */
export interface RestartRequest {
  mode: RestartMode
  base: RestartBase
  agents?: string[]
}

const SteeredSchema = z.object({ message: z.object({ event_id: z.string().min(1), at: text }) })
const RestartedSchema = z.object({ run: z.object({ run_id: z.string().min(1) }) })

/** A read that is not its shape at all is an error (a bad entry inside one costs itself). */
function parsed<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const read = schema.safeParse(raw)
  if (!read.success) throw new Error(`The ${what} answer was unreadable`)
  return read.data
}

const runRoute = (runId: string, suffix: string) => `/agents/engineering/${encodeURIComponent(runId)}${suffix}`
const agentRoute = (runId: string, agent: string, suffix: string) =>
  runRoute(runId, `/agents/${encodeURIComponent(agent)}${suffix}`)
/** `?a=1&b=2` of the parameters given ('' when none is). */
function queryOf(params: Readonly<Record<string, string | undefined>>): string {
  const given = Object.entries(params).flatMap(([name, value]) => (value === undefined || value === '' ? [] : [[name, value]]))
  return given.length === 0 ? '' : `?${new URLSearchParams(given).toString()}`
}

export const runWorkspaceKeys = {
  /** Every thread of a run (what a person's steering may change). */
  threads: (runId: string) => ['engineering-runs', runId, 'thread'] as const,
  thread: (runId: string, agent: string) => ['engineering-runs', runId, 'thread', agent] as const,
  /** `version`: what the item said when it was opened (a tool call's status), so a result that lands is read again. */
  threadItem: (runId: string, agent: string, ref: string, version: string) =>
    ['engineering-runs', runId, 'thread', agent, ref, version] as const,
  changes: (runId: string, agent: string, key: string) => ['engineering-runs', runId, 'changes', agent, key] as const,
  changeFile: (runId: string, agent: string, key: string, path: string) =>
    ['engineering-runs', runId, 'changes', agent, key, path] as const,
  inspector: (runId: string, agent: string, tab: 'files' | 'gate' | 'memory') =>
    ['engineering-runs', runId, tab, agent] as const,
  assertions: (runId: string) => ['engineering-runs', runId, 'assertions'] as const,
  runs: (query: RunsQuery) => ['engineering-runs', 'list', query.month, query.flow, query.status] as const,
  /** Every page of the runs list, whatever its filters (what a confirmed run request changes, 7.53.00). */
  runsLists: () => ['engineering-runs', 'list'] as const,
}

export const runWorkspaceApi = {
  /** A page of the agent's thread after `after` (none: from its start). */
  thread: async (runId: string, agent: string, after: string | null): Promise<ThreadPage> => {
    const query = queryOf({ after: after ?? undefined, limit: String(THREAD_PAGE) })
    return parsed(ThreadPageSchema, await fetchApi<unknown>(agentRoute(runId, agent, `/thread${query}`)), 'thread')
  },
  threadItem: async (runId: string, agent: string, ref: string): Promise<ThreadEvent> =>
    parsed(ThreadEventSchema, await fetchApi<unknown>(agentRoute(runId, agent, `/thread/${encodeURIComponent(ref)}`)), 'item'),
  /** The agent's changes: the patch `key` names, else its submitted one (else its latest checkpoint's). */
  changes: async (runId: string, agent: string, key: string): Promise<AgentChanges> =>
    parsed(ChangesSchema, await fetchApi<unknown>(agentRoute(runId, agent, `/changes${queryOf({ key })}`)), 'changes'),
  changeFile: async (runId: string, agent: string, key: string, path: string): Promise<FilePatch> =>
    parsed(FilePatchSchema, await fetchApi<unknown>(agentRoute(runId, agent, `/changes/file${queryOf({ key, path })}`)), 'file'),
  files: async (runId: string, agent: string): Promise<AgentFiles> =>
    parsed(FilesSchema, await fetchApi<unknown>(agentRoute(runId, agent, '/files')), 'files'),
  gate: async (runId: string, agent: string): Promise<AgentGate> =>
    parsed(GateSchema, await fetchApi<unknown>(agentRoute(runId, agent, '/gate')), 'gate'),
  memory: async (runId: string, agent: string): Promise<AgentMemory> =>
    parsed(MemorySchema, await fetchApi<unknown>(agentRoute(runId, agent, '/memory')), 'memory'),
  /** The run's assertions, step by step (a bare list). */
  assertions: async (runId: string): Promise<RunAssertion[]> =>
    eachOf(AssertionSchema).parse(await fetchApi<unknown>(runRoute(runId, '/assertions'))),
  /** A page of the runs started in a month, newest first (`cursor`: the `next` of the page before). */
  runs: async (query: RunsQuery, cursor: string | null): Promise<CursorPage<ListedRun>> => {
    const search = queryOf({ month: query.month, flow: query.flow, status: query.status, cursor: cursor ?? undefined })
    const page = parsed(RunsPageSchema, await fetchApi<unknown>(`/agents/engineering/runs${search}`), 'runs')
    return { rows: page.runs, nextCursor: page.next }
  },
  /** A person's steering, to the orchestrator: when the conversation recorded it (an answer naming no message is an error). */
  steer: async (runId: string, request: SteerRequest): Promise<string> =>
    parsed(SteeredSchema, await fetchApi<unknown>(runRoute(runId, '/steer'), post(request)), 'steering').message.at,
  /** An ended run started again as a child run: the child's id (the page opens it). */
  restart: async (runId: string, request: RestartRequest): Promise<string> => {
    const raw = await fetchApi<unknown>(runRoute(runId, '/restart'), post({ ...request, confirm: true }))
    return parsed(RestartedSchema, raw, 'restart').run.run_id
  },
}
