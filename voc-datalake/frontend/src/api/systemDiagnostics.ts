/**
 * @fileoverview The diagnostics next to `GET /logs/system` (admin-only, logs Lambda):
 *
 * - `GET /logs/system/request` — every line (any level) of ONE invocation of one
 *   function, read with CloudWatch Logs Insights; asynchronous like `/logs/system`
 *   (`status: 'running'` + `query_id` to poll with).
 * - `GET /logs/system/queues` — the deployment's dead-letter / failure queues: depth,
 *   age of the oldest message and up to three redacted sample bodies.
 * - `GET /logs/system/environment` — what is deployed and how it is configured
 *   (version, region, enabled sources, models…), nothing secret.
 *
 * Every answer is normalized through a lenient Zod schema; an unreadable answer
 * never reads as "nothing wrong".
 *
 * @module api/systemDiagnostics
 */
import { z } from 'zod'
import { isRecord } from '../lib/typeGuards'
import { lenientText, optionalText, parsedList } from './schemaList'

// ── GET /logs/system/request ─────────────────────────────────────────────────

const SystemRequestLineSchema = z.object({
  timestamp: lenientText,
  // Any level: INFO and DEBUG lines are the point of this view.
  level: z.string().min(1).catch('INFO'),
  message: lenientText,
})
export type SystemRequestLine = z.output<typeof SystemRequestLineSchema>

const SystemRequestSchema = z.object({
  status: z.enum(['complete', 'running', 'failed']).catch('failed'),
  query_id: optionalText,
  lines: parsedList(SystemRequestLineSchema),
  truncated: z.boolean().catch(false),
})
export type SystemRequest = z.output<typeof SystemRequestSchema>

const UNREADABLE_REQUEST: SystemRequest = SystemRequestSchema.parse({ status: 'failed' })

/** The answer as the request view reads it; a non-object, or `running` without an id to poll, is `failed`. */
export function normalizeSystemRequest(raw: unknown): SystemRequest {
  const parsed = SystemRequestSchema.safeParse(raw)
  if (!parsed.success) return UNREADABLE_REQUEST
  if (parsed.data.status === 'running' && parsed.data.query_id === undefined) return UNREADABLE_REQUEST
  return parsed.data
}

/** Query parameters of `GET /logs/system/request`: the group's function, request id and newest occurrence. */
export interface SystemRequestParams {
  readonly function: string
  readonly request_id: string
  readonly at: string
  readonly query_id?: string
}

// ── GET /logs/system/queues ──────────────────────────────────────────────────

const SystemFailureQueueSchema = z.object({
  name: z.string().min(1),
  // null: the route could not read this queue (it says so in `error`) — never "0 messages".
  messages: z.number().int().nonnegative().nullable().catch(null),
  oldest_age_seconds: z.number().nonnegative().optional().catch(undefined),
  sample: z.array(z.string()).catch([]),
})
export type SystemFailureQueue = z.output<typeof SystemFailureQueueSchema>

// The envelope is strict (a missing list is not "no queues"); each row is lenient.
const SystemFailureQueuesSchema = z.object({
  queues: z.array(z.unknown()).pipe(parsedList(SystemFailureQueueSchema)),
})
export type SystemFailureQueues = z.output<typeof SystemFailureQueuesSchema>

/** A missing or drifted envelope throws: the card shows a load error, never "all queues are empty". */
export function normalizeSystemFailureQueues(raw: unknown): SystemFailureQueues {
  const parsed = SystemFailureQueuesSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Unreadable failure queues answer')
  return parsed.data
}

// ── GET /logs/system/environment ─────────────────────────────────────────────

/** One environment value as shown: text, a yes/no, or a list of texts. */
export type SystemEnvironmentValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'flag'; readonly on: boolean }
  | { readonly kind: 'list'; readonly items: readonly string[] }

export interface SystemEnvironmentEntry {
  readonly key: string
  readonly value: SystemEnvironmentValue
  /** The value exactly as the route sent it (the download carries this). */
  readonly raw: unknown
}

const scalarText = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

/** Nested levels flattened into `a.b: value` lines (deeper values are left to the download). */
const MAX_DEPTH = 3

/** A record's or a list's children as (key, value); a list is numbered from 1. */
function childEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, index): [string, unknown] => [String(index + 1), item])
  return isRecord(value) ? Object.entries(value) : []
}

/** A list of scalars reads as plain lines; positions are only spelled out for records inside a list. */
function childPath(parent: unknown, path: string, key: string, child: unknown): string {
  if (Array.isArray(parent) && scalarText(child) !== null) return path
  return path === '' ? key : `${path}.${key}`
}

/**
 * `{a: 'x', b: {c: 'y'}, d: [{e: 1}]}` → `['a: x', 'b.c: y', 'd.1.e: 1']`: every scalar of a
 * record or list as one line (models per surface, alarms and their state, open circuits).
 */
function flattenItems(value: unknown, path: string, depth: number): string[] {
  const text = scalarText(value)
  if (text !== null) {
    if (text === '') return []
    return [path === '' ? text : `${path}: ${text}`]
  }
  if (depth >= MAX_DEPTH) return []
  return childEntries(value).flatMap(([key, inner]) => flattenItems(inner, childPath(value, path, key, inner), depth + 1))
}

function environmentValue(value: unknown): SystemEnvironmentValue | null {
  if (typeof value === 'boolean') return { kind: 'flag', on: value }
  if (Array.isArray(value) || isRecord(value)) return { kind: 'list', items: flattenItems(value, '', 0) }
  const text = scalarText(value)
  return text === null || text === '' ? null : { kind: 'text', text }
}

const SystemEnvironmentSchema = z.record(z.string(), z.unknown())

/**
 * The environment as an ordered list of shown entries. The route's field set may
 * grow, so every key is kept (unknown keys show under their own name); a null or
 * empty value is dropped. A non-object answer throws (the block shows a load error).
 */
export function normalizeSystemEnvironment(raw: unknown): SystemEnvironmentEntry[] {
  const parsed = SystemEnvironmentSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Unreadable environment answer')
  return Object.entries(parsed.data).flatMap(([key, value]) => {
    const shown = environmentValue(value)
    return shown === null ? [] : [{ key, value: shown, raw: value }]
  })
}
