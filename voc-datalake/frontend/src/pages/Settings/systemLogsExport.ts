/**
 * @fileoverview The System errors download: one JSON file holding everything the
 * tab knows — the grouped errors, the whole-request lines of every request the
 * admin opened, the failure queues, the environment, and the period's validation
 * failures and processing errors — so a developer WITHOUT access to the AWS
 * account can work out what failed and why. Every text in it is what the routes
 * returned (redacted server-side).
 * @module pages/Settings/systemLogsExport
 */
import type { QueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { SystemLogFilter, SystemLogs } from '../../api/systemLogs'
import type { SystemEnvironmentEntry, SystemFailureQueues } from '../../api/systemDiagnostics'
import { downloadFile } from '../../utils/file'
import { BUILD_INFO, paddedVersion } from './buildInfo'
import { SYSTEM_ENVIRONMENT_KEY, SYSTEM_QUEUES_KEY, openedRequests } from './useSystemLogs'

/** How many validation failures / processing errors the file carries (newest first). */
const SOURCE_LOG_LIMIT = 100

/** English on purpose: the reader is whoever the file is handed to. */
const HOW_TO_READ = [
  'This file is an export of Administration > System > Logs > System errors of one Voice of Customer deployment.',
  '"groups" are log lines grouped by function, level and normalized message (numbers, ids and quoted values replaced by placeholders such as <n>, <hex>, <str>);',
  '"source" says where they came from: "lambda" (a Lambda function\'s log, "function" is its short name), "api" (the API Gateway access log;',
  'level HTTP = a 5xx answer, WARNING = a 4xx other than 401/403/404/409/410) or "workflow" (a Step Functions execution or task that failed);',
  'level PLATFORM = the Lambda runtime itself (timeout, out of memory, crash). "sample" is the newest raw occurrence, "count" how often it',
  'happened between "first_seen" and "last_seen" (UTC), "request_id" the invocation of that newest occurrence. "request_lines", when present,',
  'are every log line (any level) of that one invocation, oldest first, which usually shows what the function was doing before it failed.',
  '"queues" are the dead-letter / failure queues: "messages" is work that failed every retry and will not be retried, "sample" up to three',
  'of those message bodies. "build" is the deployed version and commit; "environment" is how it is configured (region, enabled sources, models, alarms). "validation_failures" are records',
  'rejected before processing (field names only, never values) and "processing_errors" are records the processor could not enrich.',
  '"truncated": true means only the newest lines were read. Personal data was redacted by the server before export.',
].join(' ')

function environmentObject(entries: readonly SystemEnvironmentEntry[] | undefined) {
  if (entries === undefined) return null
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.raw]))
}

/** A settled read as its value, or `{error}` so the reader knows it is missing, not empty. */
function settled<T>(result: PromiseSettledResult<T>): T | { error: string } {
  return result.status === 'fulfilled' ? result.value : { error: 'Could not be loaded at export time' }
}

export interface SystemLogsExportInput {
  readonly data: SystemLogs
  readonly days: number
  readonly level: SystemLogFilter
}

/** The file's body. Reads the cached queues, environment and opened requests; fetches the period's source logs. */
async function buildSystemLogsExport(queryClient: QueryClient, input: SystemLogsExportInput) {
  const { data, days, level } = input
  const requests = openedRequests(queryClient, data.groups)
  // Async wrappers: a read that throws before returning a promise still settles as rejected.
  const [validation, processing] = await Promise.allSettled([
    (async () => (await api.getValidationLogs({ days, limit: SOURCE_LOG_LIMIT })).logs)(),
    (async () => (await api.getProcessingLogs({ days, limit: SOURCE_LOG_LIMIT })).logs)(),
  ])
  return {
    exported_at: new Date().toISOString(),
    site: window.location.origin,
    how_to_read: HOW_TO_READ,
    days,
    level,
    // What is deployed: the SPA's own build stamps (the environment route sends no version).
    build: { version: paddedVersion(BUILD_INFO.version), commit: BUILD_INFO.commit, built_at: BUILD_INFO.builtAt },
    log_groups: data.log_groups,
    truncated: data.truncated,
    environment: environmentObject(queryClient.getQueryData<SystemEnvironmentEntry[]>(SYSTEM_ENVIRONMENT_KEY)),
    queues: queryClient.getQueryData<SystemFailureQueues>(SYSTEM_QUEUES_KEY)?.queues ?? null,
    groups: data.groups.map((group) => {
      const request = requests.get(group)
      return request === undefined
        ? group
        : { ...group, request_lines: request.lines, request_lines_truncated: request.truncated }
    }),
    validation_failures: settled(validation),
    processing_errors: settled(processing),
  }
}

/** Saves the export as `voc-system-errors-<date>.json`. */
export async function downloadSystemLogs(queryClient: QueryClient, input: SystemLogsExportInput): Promise<void> {
  const body = await buildSystemLogsExport(queryClient, input)
  downloadFile(JSON.stringify(body, null, 2), `voc-system-errors-${body.exported_at.slice(0, 10)}.json`, 'application/json')
}
