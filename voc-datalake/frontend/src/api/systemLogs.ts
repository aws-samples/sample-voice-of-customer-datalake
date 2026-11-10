/**
 * @fileoverview `GET /logs/system` (admin-only, logs Lambda, `lambda/shared/system_logs.py`):
 * the ERROR / CRITICAL (optionally WARNING) lines and platform crashes of this
 * deployment's Lambdas, read with CloudWatch Logs Insights and grouped by
 * function, level and normalized message — plus the API Gateway access log's
 * 5xx (4xx) answers (`source: 'api'`, level `HTTP`) and failed Step Functions
 * executions and tasks (`source: 'workflow'`).
 *
 * The search is asynchronous: an answer with `status: 'running'` carries a
 * `query_id` to poll with. Every answer is normalized through a lenient Zod
 * schema; a drifted or missing field never reads as "no errors" — an unreadable
 * answer is `failed`.
 *
 * @module api/systemLogs
 */
import { z } from 'zod'
import { lenientText, optionalText, parsedList } from './schemaList'

const SYSTEM_LOG_LEVELS = ['ERROR', 'CRITICAL', 'WARNING', 'PLATFORM', 'HTTP'] as const
export type SystemLogLevel = (typeof SYSTEM_LOG_LEVELS)[number]

/** Where a group's lines came from: a Lambda, the API Gateway access log, or a Step Functions workflow. */
const SYSTEM_LOG_SOURCES = ['lambda', 'api', 'workflow'] as const

/** The `level` query parameter: errors only, or errors and warnings. */
export const SYSTEM_LOG_FILTERS = ['error', 'warning'] as const
export type SystemLogFilter = (typeof SYSTEM_LOG_FILTERS)[number]

const count = z.number().int().nonnegative().catch(0)

const SystemLogGroupSchema = z.object({
  function: z.string().min(1).catch('unknown'),
  // Answers before 5.44 carried no source: every group then was a Lambda's.
  source: z.enum(SYSTEM_LOG_SOURCES).catch('lambda'),
  level: z.enum(SYSTEM_LOG_LEVELS).catch('ERROR'),
  message: lenientText,
  sample: lenientText,
  count: z.number().int().positive().catch(1),
  first_seen: lenientText,
  last_seen: lenientText,
  request_id: z.string().min(1).nullable().catch(null),
})
export type SystemLogGroup = z.output<typeof SystemLogGroupSchema>

/**
 * Whether a group's whole request can be loaded (`GET /logs/system/request`): only a
 * Lambda's or workflow's, with a request id; an API Gateway row's id is the gateway's.
 */
export function canShowRequest(group: SystemLogGroup): boolean {
  return group.source !== 'api' && group.request_id !== null
}

const SystemLogsSchema = z.object({
  status: z.enum(['complete', 'running', 'failed']).catch('failed'),
  query_id: optionalText,
  message: optionalText,
  log_groups: count,
  truncated: z.boolean().catch(false),
  count,
  groups: parsedList(SystemLogGroupSchema),
})
export type SystemLogs = z.output<typeof SystemLogsSchema>

const UNREADABLE: SystemLogs = SystemLogsSchema.parse({ status: 'failed' })

/** The answer as the panel reads it; a non-object, or `running` without an id to poll, is `failed`. */
export function normalizeSystemLogs(raw: unknown): SystemLogs {
  const parsed = SystemLogsSchema.safeParse(raw)
  if (!parsed.success) return UNREADABLE
  if (parsed.data.status === 'running' && parsed.data.query_id === undefined) return UNREADABLE
  return parsed.data
}

/** Query parameters of `GET /logs/system`. `query_id` polls an earlier `running` answer. */
export interface SystemLogsParams {
  readonly days: number
  readonly level: SystemLogFilter
  readonly query_id?: string
}
