/**
 * @fileoverview Lenient boundary schemas for assistant sessions stored through
 * `/chat/conversations/*` (DynamoDB `voc-conversations`, per Cognito user).
 *
 * Follows the `formSchema.ts` / `scrapersSchema.ts` precedent: every field has
 * a `catch` default and list entries that fail are dropped, so one legacy or
 * half-written record never blanks the sessions drawer. Messages are validated
 * entry-by-entry against AG-UI's own `MessageSchema`.
 *
 * @module assistant/sessions/schema
 */
import { z } from 'zod'
import { MessageSchema } from '@ag-ui/core/schemas'
import { SESSION_RUN_STATUSES, STALE_RUN_SECONDS, pageContextSchema } from '../contract'
import { lenientList } from '../lenient'
import { parseApprovalInterrupts } from '../thread/customEvents'
import type { Message } from '@ag-ui/core'
import type { PageContext } from '../contract'
import type { ApprovalInterrupt } from '../types'

/** Session ids are thread ids; this is what the conversations route accepts. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const SESSION_KIND = 'assistant'

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id)
}

const text = z.string().catch('')

const sessionSummarySchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  title: text,
  kind: text,
  messageCount: z.number().int().nonnegative().catch(0),
  createdAt: text,
  updatedAt: text,
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

const listEnvelope = z.object({ conversations: z.unknown().optional() }).catch({ conversations: [] })

/** `GET /chat/conversations/_list?kind=assistant`, newest first. */
export function normalizeSessionList(raw: unknown): SessionSummary[] {
  return lenientList(sessionSummarySchema, listEnvelope.parse(raw).conversations)
    .filter((s) => s.kind === '' || s.kind === SESSION_KIND)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

type SessionRunStatus = (typeof SESSION_RUN_STATUSES)[number]

export interface SessionRecord {
  id: string
  title: string
  kind: typeof SESSION_KIND
  messages: Message[]
  page: PageContext | null
  pendingInterrupts: ApprovalInterrupt[]
  createdAt: string
  updatedAt: string
  /** The stream Lambda's run state; null = never saved server-side. */
  runStatus: SessionRunStatus | null
  /** The server's revision (grows only); sent back as `baseRevision` on save. */
  revision: number
}

const recordEnvelope = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  title: text,
  // `.optional()`: from zod 4.6 a bare `z.unknown()` key is required, so a
  // record missing one of these would be rejected as a whole.
  messages: z.unknown().optional(),
  page: z.unknown().optional(),
  pendingInterrupts: z.unknown().optional(),
  createdAt: text,
  updatedAt: text,
  runStatus: z.enum(SESSION_RUN_STATUSES).nullable().catch(null),
  revision: z.number().int().nonnegative().catch(0),
})

function toMessage(entry: unknown): Message[] {
  const parsed = MessageSchema.safeParse(entry)
  return parsed.success ? [parsed.data] : []
}

/** `GET /chat/conversations/{id}`; null when the record is unusable. */
export function normalizeSessionRecord(raw: unknown): SessionRecord | null {
  const envelope = recordEnvelope.safeParse(raw)
  if (!envelope.success) return null
  const record = envelope.data
  const page = pageContextSchema.safeParse(record.page)
  return {
    id: record.id,
    title: record.title,
    kind: SESSION_KIND,
    messages: Array.isArray(record.messages) ? record.messages.flatMap(toMessage) : [],
    page: page.success ? page.data : null,
    pendingInterrupts: parseApprovalInterrupts(record.pendingInterrupts),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    runStatus: record.runStatus,
    revision: record.revision,
  }
}

/**
 * The stream Lambda is still generating this session's answer: stored as
 * `running` and written within STALE_RUN_SECONDS (an older `running` record is
 * a run that died — the Lambda times out well before that).
 */
export function isLiveServerRun(record: Pick<SessionRecord, 'runStatus' | 'updatedAt'>, nowMs: number = Date.now()): boolean {
  if (record.runStatus !== 'running') return false
  const updated = Date.parse(record.updatedAt)
  return Number.isFinite(updated) && nowMs - updated < STALE_RUN_SECONDS * 1000
}
