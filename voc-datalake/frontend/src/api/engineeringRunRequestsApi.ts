/**
 * @fileoverview Run requests (7.53.00, "MCP for runs", D53-3; `lambda/engineering/run_requests.py`): a local Kiro or
 * Claude agent asks for a Run now of an enabled engineering automation over MCP (`engineering_run_request`), and the
 * request waits in Agents → Runs until an administrator confirms it (the automation's Run now, as them) or declines it.
 * The web app lists them (`GET /agents/engineering/requests`, newest first) and decides them
 * (`POST …/requests/<id>/confirm | decline`); it never asks for one. Lenient like the runs list: a bad entry costs
 * itself, an unknown status is kept as text.
 *
 * @module api/engineeringRunRequestsApi
 */
import { z } from 'zod'
import { post } from './requestKit'
import { fetchApi } from './client'
import { eachOf } from './lenientFields'

const text = z.string().catch('')
const maybeText = z.string().nullable().catch(null)

const RunRequestSchema = z.object({
  request_id: z.string().min(1),
  /** `pending`, `confirmed`, `declined` or `expired` (a pending one past its time). */
  status: text,
  agent_id: text,
  agent_name: text,
  issue: z.number().int().positive().nullable().catch(null),
  prd: z.object({ project_id: z.string(), document_id: z.string() }).nullable().catch(null),
  note: maybeText,
  requested_at: text,
  expires_at: text,
  /** Who asked: the MCP credential (`mcp:<token>`), acting for its minter. */
  via: text,
  decided_at: maybeText.optional().transform((at) => at ?? null),
  /** What came of a confirm: `started`, `uncertain`, or the refusal's words. */
  outcome: maybeText.optional().transform((outcome) => outcome ?? null),
  engineering_run_id: maybeText.optional().transform((run) => run ?? null),
})
export type RunRequest = z.output<typeof RunRequestSchema>

const ListSchema = z.object({ requests: eachOf(RunRequestSchema) })
const DecidedSchema = z.object({ request: RunRequestSchema })

/** What a person decides about a waiting request. */
export type RunRequestDecision = 'confirm' | 'decline'

function decided(raw: unknown): RunRequest {
  const read = DecidedSchema.safeParse(raw)
  if (!read.success) throw new Error('The run request answer was unreadable')
  return read.data.request
}

export const runRequestsKeys = {
  list: () => ['engineering-runs', 'requests'] as const,
}

export const runRequestsApi = {
  /** The requests, newest first (the pending ones, those decided and those expired). */
  list: async (): Promise<RunRequest[]> => {
    const read = ListSchema.safeParse(await fetchApi<unknown>('/agents/engineering/requests'))
    if (!read.success) throw new Error('The run requests answer was unreadable')
    return read.data.requests
  },
  /** Confirm a waiting request: the automation's Run now starts, as the person confirming; the request as decided. */
  confirm: async (requestId: string): Promise<RunRequest> =>
    decided(await fetchApi<unknown>(`/agents/engineering/requests/${encodeURIComponent(requestId)}/confirm`, post({}))),
  /** Decline a waiting request: nothing starts. */
  decline: async (requestId: string): Promise<RunRequest> =>
    decided(await fetchApi<unknown>(`/agents/engineering/requests/${encodeURIComponent(requestId)}/decline`, post({}))),
}
