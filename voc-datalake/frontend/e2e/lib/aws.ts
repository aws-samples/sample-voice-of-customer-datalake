/**
 * The one AWS CLI runner of the suite (the operator's own credentials,
 * read-only calls only), plus Step Functions execution evidence. CloudWatch
 * REPORT lines live in lib/cloudwatch.ts on top of this runner. Arguments are
 * passed as an argv array (no shell), and no execution input/output is ever
 * written.
 */
import { execFileSync } from 'node:child_process'
import { isRecord } from './guards'

/** Region of the deployment: E2E_AWS_REGION, else AWS_REGION, else us-west-2. */
export const REGION = process.env['E2E_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-west-2'

/** `aws <args> --region <REGION> --output json`, parsed (null for an empty body). Throws when the CLI fails. */
export function aws(args: readonly string[]): unknown {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out.trim() === '' ? null : JSON.parse(out)
}

/** Upper bound on pages per paginated CLI call (a runaway token never loops forever). */
const MAX_PAGES = 20

/** Every item under `key` across a paginated CLI call (`nextToken` protocol). */
export function paginate(args: readonly string[], key: string): unknown[] {
  const items: unknown[] = []
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = aws(token === undefined ? [...args] : [...args, '--next-token', token])
    if (isRecord(body) && Array.isArray(body[key])) items.push(...body[key])
    token = isRecord(body) && typeof body['nextToken'] === 'string' ? body['nextToken'] : undefined
    if (token === undefined) break
  }
  return items
}

export interface ExecutionSummary {
  arn: string
  status: string
  startDate: string | null
  stopDate: string | null
  durationMs: number | null
  events: number
  /** Task/Map/Wait states in order, with wall time between Entered and Exited. */
  states: Array<{ name: string; type: string; ms: number | null }>
  failures: string[]
}

function epoch(value: unknown): number | null {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function stateTimings(history: unknown[]): ExecutionSummary['states'] {
  const open = new Map<string, Array<{ type: string; at: number | null }>>()
  const states: ExecutionSummary['states'] = []
  for (const event of history) {
    if (!isRecord(event)) continue
    const type = String(event['type'] ?? '')
    const entered = isRecord(event['stateEnteredEventDetails']) ? event['stateEnteredEventDetails'] : null
    const exited = isRecord(event['stateExitedEventDetails']) ? event['stateExitedEventDetails'] : null
    if (entered !== null) {
      const name = String(entered['name'] ?? '')
      open.set(name, [...(open.get(name) ?? []), { type: type.replace(/StateEntered$/, ''), at: epoch(event['timestamp']) }])
    }
    if (exited !== null) {
      const name = String(exited['name'] ?? '')
      const started = open.get(name)?.shift()
      const at = epoch(event['timestamp'])
      states.push({ name, type: started?.type ?? '', ms: started?.at != null && at !== null ? at - started.at : null })
    }
  }
  return states
}

/** describe-execution + the full history, reduced to timings (no input/output). */
export function stepFunctionsExecution(arn: string): ExecutionSummary {
  const described = aws(['stepfunctions', 'describe-execution', '--execution-arn', arn])
  const history = paginate(['stepfunctions', 'get-execution-history', '--execution-arn', arn, '--max-results', '1000'], 'events')
  const d = isRecord(described) ? described : {}
  const start = epoch(d['startDate'])
  const stop = epoch(d['stopDate'])
  const failures = history.flatMap((event) => {
    if (!isRecord(event)) return []
    const type = String(event['type'] ?? '')
    return /Failed|TimedOut|Aborted/.test(type) ? [type] : []
  })
  return {
    arn,
    status: String(d['status'] ?? 'UNKNOWN'),
    startDate: start === null ? null : new Date(start).toISOString(),
    stopDate: stop === null ? null : new Date(stop).toISOString(),
    durationMs: start !== null && stop !== null ? stop - start : null,
    events: history.length,
    states: stateTimings(history),
    failures,
  }
}

let cachedAccount: string | null = null

/** The deployment's account: E2E_AWS_ACCOUNT, else one STS call per process. */
export function accountId(): string {
  if (cachedAccount !== null) return cachedAccount
  const fromEnv = process.env['E2E_AWS_ACCOUNT']
  if (fromEnv !== undefined && fromEnv !== '') {
    cachedAccount = fromEnv
    return cachedAccount
  }
  const body = aws(['sts', 'get-caller-identity'])
  cachedAccount = isRecord(body) && typeof body['Account'] === 'string' ? body['Account'] : ''
  return cachedAccount
}

/**
 * Physical name of a deployed function from its base name (`voc-chat-stream`,
 * as in lib/utils/function-names.ts): `<base>-<account>-<region>`.
 */
export function physicalName(base: string): string {
  return `${base}-${accountId()}-${REGION}`
}
