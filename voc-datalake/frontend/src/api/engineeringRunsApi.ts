/**
 * @fileoverview An engineering run, as the run monitor reads it and acts on it (`/agents/engineering/<run_id>…`,
 * `lambda/engineering/monitor.py` and `views.py`, docs/autonomous-agents.md "An engineering run"): the overview (the
 * run, each agent's session as the supervisor keeps it, the tokens per model; no cost yet), the board, a page of the
 * conversation (where signals are recorded too, as `signal.*` messages), and an admin's signals and answers. Every read is lenient: a bad entry costs itself, an unknown state
 * or signal is kept as text.
 *
 * @module api/engineeringRunsApi
 */
import { z } from 'zod'
import { post } from './requestKit'
import { fetchApi } from './client'
import { nextAfterOf } from './seqPages'
import { lenientList, parseEach } from './lenientFields'
import { isRecord } from '../lib/typeGuards'

export const ENGINEERING_SIGNALS = ['save', 'pause', 'resume', 'shutdown', 'stop_now'] as const
export type EngineeringSignal = (typeof ENGINEERING_SIGNALS)[number]
/** The board's states, in the order the monitor shows them (`engineering/board/model.py`). */
export const TASK_STATES = ['open', 'claimed', 'in_progress', 'in_review', 'needs_human', 'failed', 'done'] as const
/** The longest answer a person sends (voc-msg/1's summary, in UTF-8 bytes). */
export const MAX_ANSWER_BYTES = 1024

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)
const count = z.number().catch(0)
/** A list whose entries are each parsed by `schema` (their defaults applied); a bad one costs itself. */
const eachOf = <T>(schema: z.ZodType<T>) => z.unknown().optional().transform((value) => parseEach(schema, value))

/** The board states in which a task is over: its agent is no longer signalled through it. */
export const FINAL_TASK_STATES: readonly string[] = ['done', 'failed', 'needs_human']

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
})
export type EngineeringAgent = z.output<typeof AgentSchema>

const PartySchema = z.object({ kind: text, id: text }).catch({ kind: '', id: '' })

const OverviewSchema = z.object({
  run: z.object({
    run_id: text, goal: text, repo: text, flow: text, status: text, started_at: maybeText, ended_at: maybeText,
  }),
  agents: eachOf(AgentSchema),
  totals: z.object({ messages: count, microvm_seconds: count, by_model: eachOf(TokensSchema) })
    .catch({ messages: 0, microvm_seconds: 0, by_model: [] }),
})
export type EngineeringOverview = z.output<typeof OverviewSchema>

/** What a signal did: each agent's status after it, as the supervisor answered. */
const SignalSentSchema = z.object({
  signal: z.object({ agents: z.record(z.string(), z.string()).catch({}) }),
})
export type SignalSent = z.output<typeof SignalSentSchema>['signal']

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

export interface ConversationPage {
  items: ConversationMessage[]
  nextAfter: number
}

export interface SignalRequest {
  signal: EngineeringSignal
  /** With its `attempt` (the task's lease epoch): the agent on the task; neither: the whole run. */
  task_id?: string
  attempt?: number
  note?: string
  confirm?: boolean
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
  run: (runId: string) => ['engineering-runs', runId] as const,
  overview: (runId: string) => ['engineering-runs', runId, 'overview'] as const,
  board: (runId: string) => ['engineering-runs', runId, 'board'] as const,
  conversation: (runId: string) => ['engineering-runs', runId, 'conversation'] as const,
}

const engineeringRunPath = (runId: string, suffix = '') => `/agents/engineering/${encodeURIComponent(runId)}${suffix}`

export const engineeringRunsApi = {
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
    return parsed.success ? parsed.data.signal : { agents: {} }
  },
  answer: async (runId: string, request: AnswerRequest): Promise<unknown> =>
    fetchApi<unknown>(engineeringRunPath(runId, '/messages'), post(request)),
}
