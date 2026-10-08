/**
 * Shared bits of the read-only ops specs (tests/ops-capacity.spec.ts,
 * tests/ops-postdeploy.spec.ts): the gate, the measurement window, Logs Insights
 * through the suite's one AWS CLI runner (lib/aws.ts, the operator's own
 * credentials) and CloudWatch metric sums. Every call here is a read: list-*,
 * describe-*, get-*, Logs Insights start-query / get-query-results.
 */
import fs from 'node:fs'
import path from 'node:path'
import { insightsQuery, insightsRow } from '../../../lib/sizing/capacity'
import { aws } from './aws'
import { OUT_DIR } from './env'
import { isRecord } from './guards'

/** The ops specs run only with E2E_OPS=1 (they need AWS credentials, not Cognito users). */
export const OPS_ENABLED = process.env['E2E_OPS'] === '1'
export const OPS_SKIP_REASON = 'E2E_OPS=1 only: read-only AWS checks with the operator credentials (see e2e/README.md)'

export interface OpsWindow {
  startSec: number
  endSec: number
  label: string
}

/**
 * The window: E2E_OPS_SINCE (ISO time, e.g. the deploy) to now, else the last
 * E2E_OPS_HOURS hours (default 24).
 */
export function opsWindow(now: number = Date.now()): OpsWindow {
  const endSec = Math.floor(now / 1000)
  const since = process.env['E2E_OPS_SINCE']
  if (since !== undefined && since !== '') {
    const startMs = Date.parse(since)
    if (Number.isNaN(startMs) || startMs >= now) throw new Error('E2E_OPS_SINCE must be an ISO time in the past')
    return { startSec: Math.floor(startMs / 1000), endSec, label: `since ${new Date(startMs).toISOString()}` }
  }
  const hours = Number(process.env['E2E_OPS_HOURS'] ?? '24')
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('E2E_OPS_HOURS must be an integer 1..720')
  return { startSec: endSec - hours * 3600, endSec, label: `last ${hours} h` }
}

/** Logs Insights rows (as plain records) over `groups`. */
export async function insights(groups: readonly string[], query: string, window: OpsWindow): Promise<Array<Record<string, string>>> {
  const rows = await insightsQuery(aws, groups, query, { startSec: window.startSec, endSec: window.endSec })
  return rows.map(insightsRow)
}

/** `value[key]` when it is an array of records, else []. */
export function recordsAt(value: unknown, key: string): Array<Record<string, unknown>> {
  const found = isRecord(value) ? value[key] : undefined
  return Array.isArray(found) ? found.filter(isRecord) : []
}

/** Sum of a CloudWatch metric across EVERY dimension set it has in `namespace` (0 when it was never emitted). */
export function metricSum(namespace: string, name: string, window: OpsWindow): number {
  const range = ['--start-time', new Date(window.startSec * 1000).toISOString(), '--end-time', new Date(window.endSec * 1000).toISOString()]
  let total = 0
  for (const metric of recordsAt(aws(['cloudwatch', 'list-metrics', '--namespace', namespace, '--metric-name', name]), 'Metrics')) {
    const dimArgs = recordsAt(metric, 'Dimensions').map((d) => `Name=${String(d['Name'])},Value=${String(d['Value'])}`)
    const stats = aws(['cloudwatch', 'get-metric-statistics', '--namespace', namespace, '--metric-name', name, ...range,
      '--period', '3600', '--statistics', 'Sum', ...(dimArgs.length > 0 ? ['--dimensions', ...dimArgs] : [])])
    for (const point of recordsAt(stats, 'Datapoints')) total += typeof point['Sum'] === 'number' ? point['Sum'] : 0
  }
  return total
}

/** Write an evidence file under $E2E_OUT and return its path. */
export function writeEvidence(name: string, body: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  return file
}
