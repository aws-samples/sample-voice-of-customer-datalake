/**
 * @fileoverview An engineering run, as the run monitor reads it and acts on it (`/agents/engineering/<run_id>…`,
 * `lambda/engineering/monitor.py` and `views.py`, docs/autonomous-agents.md "An engineering run"): the overview (the
 * run, each agent's session as the supervisor keeps it, the tokens per model; since 7.51.00 the cost against the cap,
 * each step's lanes, the gates' verdicts, the parent and child runs; since 7.51.02 what of it this deployment reaches,
 * each by its own flag), the board, a page of the conversation, the reports (commit, PR and goal, each version's
 * Markdown), and an admin's signals (an agent's restart too: since 7.51.02 through the start function, which records
 * them on the run's own rows and hands them on), answers and (7.50.03) Stop of the whole run (`POST …/stop`, through
 * the start function: it ends the run whatever its agents are doing). The run workspace's own reads are
 * api/engineeringRunWorkspaceApi.ts. Every read is lenient: a bad entry costs itself, an unknown state or signal is
 * kept as text.
 *
 * @module api/engineeringRunsApi
 */
import { z } from 'zod'
import { post } from './requestKit'
import { fetchApi } from './client'
import { nextAfterOf } from './seqPages'
import { eachOf, lenientList } from './lenientFields'
import { isRecord } from '../lib/typeGuards'
import { normalizeDefinition } from './workflowsApi'
import { ReactionsSchema } from './engineeringReactionsApi'

/** The signals a run's agents take (`engineering/monitor.py` SIGNALS). */
export type EngineeringSignal = 'save' | 'pause' | 'resume' | 'shutdown' | 'stop_now'
/** A run's statuses once it has ended (`runtime/runs.py` ENDED): it takes no more actions. */
export const ENDED_RUN_STATUSES: readonly string[] = ['done', 'failed', 'stopped']
/** The board's states, in the order the monitor shows them (`engineering/board/model.py`). */
export const TASK_STATES = ['open', 'claimed', 'in_progress', 'in_review', 'needs_human', 'failed', 'done'] as const
/** The longest answer a person sends (voc-msg/1's summary, in UTF-8 bytes). */
export const MAX_ANSWER_BYTES = 1024

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)
const count = z.number().catch(0)

/** The board states in which a task is over: its agent is no longer signalled through it. */
export const FINAL_TASK_STATES: readonly string[] = ['done', 'failed', 'needs_human']
/** The moves a task's holder may make, from a state to the next (`engineering/board/model.py` MOVES). */
export const TASK_MOVES: Readonly<Record<string, readonly string[]>> = {
  claimed: ['in_progress', 'failed', 'needs_human'],
  in_progress: ['in_review', 'done', 'failed', 'needs_human'],
  in_review: ['in_progress', 'done', 'failed', 'needs_human'],
}
/** The run coordinator's own task, which no person acts on (`engineering/board/store.py` COORDINATE_TASK). */
export const COORDINATE_TASK = 'coordinate'
/** A person's id on the board: a task they hold has lease agent `human:<their subject>`. */
export const PERSON_PREFIX = 'human:'
/** A person's actions on one task (`…/board/tasks/<task_id>/<action>`). */
export type BoardAction =
  | { action: 'take'; over?: boolean }
  | { action: 'block'; reason: string; over?: boolean }
  | { action: 'priority'; priority: number }
  | { action: 'move'; to: string }
  | { action: 'release' }
/** A person's new task: `spec` says what to do (`{instructions}`). */
export interface NewTask {
  role: string
  title: string
  spec: Record<string, unknown>
}

const maybeCount = z.number().nullable().catch(null)
const TokensSchema = z.object({ model: text, input_tokens: count, output_tokens: count })

const AgentSchema = z.object({
  agent: z.string().min(1),
  role: text, task_id: maybeText, status: text, continuation: count,
  /** Epoch seconds. */
  started_at: maybeCount,
  /** The harness's own words for where it is (a flow step's id when it is on one). */
  step: maybeText,
  microvm_state: maybeText,
  /** Seconds. */
  microvm_age: maybeCount, heartbeat_age: maybeCount,
  /** Epoch seconds. */
  last_progress_at: maybeCount,
  stuck_why: maybeText,
  recent_tools: lenientList((item: unknown): item is string => typeof item === 'string'),
  microvm_seconds: count,
  tokens: eachOf(TokensSchema),
  /** (7.51.00) What its tokens cost at their prices, in USD; null when unsaid. */
  cost_usd: maybeCount.optional().transform((usd) => usd ?? null),
  /** The attempt of its task it is on (the one a signal to it names), its commit, its skill's label and its model. */
  attempt: count.optional().transform((attempt) => attempt ?? 0),
  commit: maybeText.optional().transform((commit) => commit ?? null),
  skill_label: maybeText.optional().transform((label) => label ?? null),
  model: maybeText.optional().transform((model) => model ?? null),
})
export type EngineeringAgent = z.output<typeof AgentSchema>

const PartySchema = z.object({ kind: text, id: text }).catch({ kind: '', id: '' })

/** The run's flow budget (copied at its start) and the highest level its flow's month passed; null for none. */
const RunBudgetSchema = z.object({
  monthly_usd: z.number().positive(),
  alert_percent: z.number().int().positive().nullable().catch(null),
  alert_month: z.string().nullable().catch(null),
}).nullable().catch(null)

/** Each step's status in the run's own copy of its flow, as the conductor reads it
 * (`lambda/engineering/flow/conductor.py`); null for a run started without a flow. */
const FlowStepsSchema = z.record(z.string(), z.string()).nullable().catch(null)
/** The revision of the flow the run's start copied; null for none. */
const FlowRevisionSchema = z.number().int().positive().nullable().catch(null)

/** The host kinds a connection is on (`lambda/engineering/run_links.py` HOSTS). */
const RunHostSchema = z.enum(['github', 'gitlab'])
const LinkNumberSchema = z.number().int().positive()
/** The issue the run was started from, as its start recorded it (`verified` false: as given); null for none. */
const IssueLinkSchema = z.object({
  host: RunHostSchema, number: LinkNumberSchema, url: z.string(), verified: z.boolean().catch(false),
}).nullable().catch(null)
/** The run's draft pull request (a GitLab merge request) as the broker recorded the host's answer; null for none. */
const PullRequestLinkSchema = z.object({
  host: RunHostSchema, number: LinkNumberSchema, url: z.string(), head: text, base: text,
}).nullable().catch(null)
export type RunIssueLink = NonNullable<z.output<typeof IssueLinkSchema>>
/** (7.51.00) A run restarted from another: its parent (on the child), or a child (on the parent): who, when, how. */
const RunLinkSchema = z.object({ run_id: z.string().min(1), mode: text, by: text, at: text })
/** An ended run's manifest: what it cost and used, as its end wrote it; null before. */
const ManifestSchema = z.object({ cost_usd: maybeCount, tokens: maybeCount, written_at: maybeText }).nullable().catch(null)
/** (7.51.00) One task of a flow step and the agent on it: a lane of the step's stage on the canvas. */
const LaneSchema = z.object({
  agent: maybeText, role: text, status: maybeText, state: text, task_id: text, attempt: count, shard: maybeText,
})
export type RunLane = z.output<typeof LaneSchema>
export type RunPullRequestLink = NonNullable<z.output<typeof PullRequestLinkSchema>>

/** A person's Stop of the whole run (7.50.03): how it was asked and when; null for none. */
const RunStopSchema = z.object({
  mode: z.enum(['stop', 'stop_now']).catch('stop'),
  requested_at: text,
}).nullable().catch(null)

const OverviewSchema = z.object({
  run: z.object({
    run_id: text, goal: text, repo: text, flow: text, status: text, started_at: maybeText, ended_at: maybeText,
    /** The decision point a run at a person waits at (`coordinator`, `budget`, `flow:<step>`…); '' for none. */
    waiting_at: z.string().optional().catch('').transform((point) => point ?? ''),
    stop: RunStopSchema.optional().transform((stop) => stop ?? null),
    budget: RunBudgetSchema.optional().transform((budget) => budget ?? null),
    flow_steps: FlowStepsSchema.optional().transform((steps) => steps ?? null),
    flow_revision: FlowRevisionSchema.optional().transform((revision) => revision ?? null),
    /** The run's own copy of its flow, as its start wrote it (what the monitor draws); null for none. */
    flow_definition: z.unknown().optional().transform((definition) => normalizeDefinition(definition ?? null)),
    issue: IssueLinkSchema.optional().transform((issue) => issue ?? null),
    pull_request: PullRequestLinkSchema.optional().transform((pull) => pull ?? null),
    /** (7.51.00) Its cost so far (Learn's apart) against its cap, in USD; null when unsaid. */
    cost_usd: maybeCount.optional().transform((usd) => usd ?? null),
    learn_cost_usd: maybeCount.optional().transform((usd) => usd ?? null),
    cost_cap_usd: maybeCount.optional().transform((usd) => usd ?? null),
    parent: RunLinkSchema.nullable().catch(null).optional().transform((parent) => parent ?? null),
    manifest: ManifestSchema.optional().transform((manifest) => manifest ?? null),
  }),
  agents: eachOf(AgentSchema),
  /** (7.51.02) What reaches the run from here, each false when unsaid: steering and answers (the stack names the
   *  engineering bus to the Agents API), Pause, Resume, Save and an agent's signals (it names the start function), a
   *  person's Stop (the start function, 7.50.03), and a person's board actions (never yet: the bus takes only steering
   *  and answers from the Agents API). */
  steer_available: z.boolean().catch(false),
  signals_available: z.boolean().catch(false),
  stop_available: z.boolean().catch(false),
  board_available: z.boolean().catch(false),
  totals: z.object({ messages: count, microvm_seconds: count, by_model: eachOf(TokensSchema) })
    .catch({ messages: 0, microvm_seconds: 0, by_model: [] }),
  /** The latest read of people's reactions to the run's pull request (7.10.00); null for none. */
  reactions: ReactionsSchema.optional().transform((reactions) => reactions ?? null),
  /** (7.51.00) Each flow step's lanes, each gate step's verdict (`GO`, `NO_GO`, …) and the runs restarted from it. */
  lanes: z.record(z.string(), eachOf(LaneSchema)).catch({}).optional().transform((lanes) => lanes ?? {}),
  gates: z.record(z.string(), z.string()).catch({}).optional().transform((gates) => gates ?? {}),
  children: eachOf(RunLinkSchema),
})
export type EngineeringOverview = z.output<typeof OverviewSchema>

/** What a signal did: since 7.51.02 it is sent (the start function recorded it and handed it on; the overview shows
 *  what came of it), so no agent's status comes back; a whole run's Shut down or Stop now (its Stop) still says each
 *  agent's (an agent the answer does not say was applied is shown as not applied). */
const SignalSentSchema = z.object({
  signal: z.object({
    agents: z.record(z.string(), z.string()).catch({}),
    applied: z.record(z.string(), z.boolean()).catch({}),
  }),
})
export type SignalSent = z.output<typeof SignalSentSchema>['signal']

/** What a Stop did (`POST …/stop`, lambda/engineering/runtime/stop.py): the run's status after it (`stopped`, or
 *  `stopping` while its agents save), the tasks it closed, the agents saving, whether it had to stop at once, and its
 *  engineering agent's run, ended with it (null for none, or not yet). */
const StopSentSchema = z.object({
  stop: z.object({
    status: text,
    mode: z.enum(['stop', 'stop_now']).catch('stop'),
    already: z.boolean().catch(false),
    fell_back: z.boolean().catch(false),
    tasks_closed: lenientList((item: unknown): item is string => typeof item === 'string'),
    saving: lenientList((item: unknown): item is string => typeof item === 'string'),
    agent_run: z.object({ agent_id: text, run_id: text, ended: z.boolean().catch(false) }).nullable().catch(null),
  }),
})
export type StopSent = z.output<typeof StopSentSchema>['stop']

const MoveSchema = z.object({ state: text, at: text, by: text, op: text, attempt: count })
const TaskSchema = z.object({
  task_id: z.string().min(1), role: text, state: text, title: text, attempt: count, priority: count,
  parent_task: maybeText,
  lease: z.object({ agent: text, epoch: count, expires: count }).nullable().catch(null),
  updated_by: text, updated_at: text,
  history: eachOf(MoveSchema),
})
export type EngineeringTask = z.output<typeof TaskSchema>

const MessageSchema = z.object({
  seq: z.number().int(),
  type: text,
  at: text,
  message: z.object({
    from: PartySchema, to: PartySchema, summary: text, thread_id: text, task_id: z.string().optional().catch(undefined),
  }),
})
export type ConversationMessage = z.output<typeof MessageSchema>

/** The report levels (`engineering/workspace/layout.py` REPORT_LEVELS), in the order the monitor lists them: its own. */
export const REPORT_LEVELS = ['goal', 'pr', 'commit'] as const

const ReportEntrySchema = z.object({ level: z.string().min(1), subject: z.string().min(1), latest_version: z.number().int().min(1) })
export type EngineeringReportEntry = z.output<typeof ReportEntrySchema>

/** One version of a report: the Markdown the server rendered, and the few facts the monitor shows beside it. */
const ReportSchema = z.object({
  report: z.object({ built_at: text }).catch({ built_at: '' }),
  markdown: z.string(),
})
export interface EngineeringReport {
  builtAt: string
  markdown: string
}

export interface ConversationPage {
  items: ConversationMessage[]
  nextAfter: number
}

/** (7.51.00) Where a restarted agent starts again (monitor.py RESTART_FROM): its newest checkpoint, or its task afresh. */
export const RESTART_FROM = ['checkpoint', 'fresh'] as const
export type RestartFrom = (typeof RESTART_FROM)[number]

export interface SignalRequest {
  /** `restart` is an agent's only (its task and attempt, `from`, `confirm: true`). */
  signal: EngineeringSignal | 'restart'
  /** With its `attempt` (the task's lease epoch): the agent on the task; neither: the whole run. */
  task_id?: string
  attempt?: number
  note?: string
  confirm?: boolean
  from?: RestartFrom
}

/** A person's Stop of the whole run: `now` stops it at once, without a checkpoint (sent confirmed). */
export interface StopRequest {
  now: boolean
}

export interface AnswerRequest {
  to: 'conductor' | 'agent'
  agent?: string
  text: string
  thread_id?: string
}

/** The overview of a run, leniently; an answer that is not one at all is an error. */
export function parseOverview(raw: unknown): EngineeringOverview {
  const parsed = OverviewSchema.safeParse(raw)
  if (!parsed.success) throw new Error('The run answer was unreadable')
  return parsed.data
}

/** A page of the conversation; `nextAfter` is where the next page starts (the server's, never behind `after`). */
export function parseConversationPage(raw: unknown, after: number): ConversationPage {
  const items = eachOf(MessageSchema).parse(isRecord(raw) ? raw.items : undefined)
  return { items, nextAfter: Math.max(after, nextAfterOf(raw, items, after)) }
}

export const engineeringRunsKeys = {
  overview: (runId: string) => ['engineering-runs', runId, 'overview'] as const,
  board: (runId: string) => ['engineering-runs', runId, 'board'] as const,
  conversation: (runId: string) => ['engineering-runs', runId, 'conversation'] as const,
  reports: (runId: string) => ['engineering-runs', runId, 'reports'] as const,
  report: (runId: string, level: string, subject: string, version: number) =>
    ['engineering-runs', runId, 'reports', level, subject, version] as const,
}

const engineeringRunPath = (runId: string, suffix = '') => `/agents/engineering/${encodeURIComponent(runId)}${suffix}`

/** A run's start (`POST /agents/engineering/runs`): a saved engineering flow, on a repository's commit. */
export interface StartRunRequest {
  workflow_id: string
  connection: string
  commit: string
  language: string
  goal: string
  /** The number of the issue the run starts from (left out for none). */
  issue?: number
}

/** The run the server started: the monitor opens it. */
const StartedRunSchema = z.object({ run: z.object({ run_id: z.string().min(1) }) })
export interface StartedRun {
  runId: string
}

export const engineeringRunsApi = {
  /** Start a run of a saved engineering flow (admin); an answer that names no run is an error. */
  start: async (request: StartRunRequest): Promise<StartedRun> => {
    const parsed = StartedRunSchema.safeParse(await fetchApi<unknown>('/agents/engineering/runs', post(request)))
    if (!parsed.success) throw new Error('The start answer was unreadable')
    return { runId: parsed.data.run.run_id }
  },
  overview: async (runId: string): Promise<EngineeringOverview> => parseOverview(await fetchApi<unknown>(engineeringRunPath(runId))),
  board: async (runId: string): Promise<EngineeringTask[]> => {
    const raw = await fetchApi<unknown>(engineeringRunPath(runId, '/board'))
    return eachOf(TaskSchema).parse(isRecord(raw) ? raw.tasks : undefined)
  },
  conversation: async (runId: string, after: number): Promise<ConversationPage> =>
    parseConversationPage(await fetchApi<unknown>(engineeringRunPath(runId, `/conversation?after=${after}`)), after),
  /** The agents' statuses after the signal (none when the answer names none). */
  signal: async (runId: string, request: SignalRequest): Promise<SignalSent> => {
    const parsed = SignalSentSchema.safeParse(await fetchApi<unknown>(engineeringRunPath(runId, '/signals'), post(request)))
    return parsed.success ? parsed.data.signal : { agents: {}, applied: {} }
  },
  answer: async (runId: string, request: AnswerRequest): Promise<unknown> =>
    fetchApi<unknown>(engineeringRunPath(runId, '/messages'), post(request)),
  /** A person's Stop of the whole run (admin); an answer that says no status is an error. */
  stop: async (runId: string, { now }: StopRequest): Promise<StopSent> => {
    const parsed = StopSentSchema.safeParse(await fetchApi<unknown>(engineeringRunPath(runId, '/stop'),
      post(now ? { now: true, confirm: true } : {})))
    if (!parsed.success || parsed.data.stop.status === '') throw new Error('The stop answer was unreadable')
    return parsed.data.stop
  },
  /** A person posts a task (admin); the board answers it, which the page reads again. */
  postTask: async (runId: string, task: NewTask): Promise<{ duplicate: boolean }> => {
    const raw = await fetchApi<unknown>(engineeringRunPath(runId, '/board/tasks'), post(task))
    // `duplicate`: an equal task still under way is answered, and nothing new is posted.
    return { duplicate: isRecord(raw) && raw.duplicate === true }
  },
  /** A person's action on one task (admin). */
  actOnTask: async (runId: string, taskId: string, { action, ...body }: BoardAction): Promise<unknown> =>
    fetchApi<unknown>(engineeringRunPath(runId, `/board/tasks/${encodeURIComponent(taskId)}/${action}`), post(body)),
  /** The run's reports, each with its latest version (a bad entry costs itself). */
  reports: async (runId: string): Promise<EngineeringReportEntry[]> => {
    const raw = await fetchApi<unknown>(engineeringRunPath(runId, '/reports'))
    return eachOf(ReportEntrySchema).parse(isRecord(raw) ? raw.items : undefined)
  },
  /** One version of a report; an answer with no Markdown is an error. */
  report: async (runId: string, level: string, subject: string, version: number): Promise<EngineeringReport> => {
    const path = `/reports/${encodeURIComponent(level)}/${encodeURIComponent(subject)}?version=${version}`
    const parsed = ReportSchema.safeParse(await fetchApi<unknown>(engineeringRunPath(runId, path)))
    if (!parsed.success) throw new Error('The report answer was unreadable')
    return { builtAt: parsed.data.report.built_at, markdown: parsed.data.markdown }
  },
}
