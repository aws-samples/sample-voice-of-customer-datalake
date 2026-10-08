/**
 * ops: the post-deploy health checks, read-only (docs/lambda-sizing.md, docs/deployment.md).
 *
 * Given the operator's ambient AWS credentials (list/describe/get calls and Logs Insights only),
 * Then, over the window:
 *   - every failure queue (DLQ / failure destination) is empty;
 *   - every voc-* CloudWatch alarm is OK;
 *   - the feedback processor's SQS event-source mapping batches 10 records / 5 s and is Enabled;
 *   - the memory workers (scanner, extractor, retention) logged 0 ERROR lines;
 *   - the custom metrics FlexFallback, ModelFallback and AssistantSessionWriteFailed sum to 0;
 *   - the API stage serves exactly the API definition's methods, and the routes retired in 3.00.00
 *     are not served (3.00.00 R1: the stage kept a removed method live until a manual redeploy —
 *     `scripts/refresh-api-stage.sh`, run by every deploy command, now refreshes it).
 *
 * The stage checks read E2E_API (the stage URL, `…/v1`) for the API id and stage name.
 *
 *   E2E_OPS=1 [E2E_OPS_HOURS=24 | E2E_OPS_SINCE=<deploy ISO time>] \
 *     npx playwright test -c playwright.ops.config.ts tests/ops-postdeploy.spec.ts
 *
 * Creates nothing, so there is no ledger entry and no cleanup. Each check is its
 * own test so one red check never hides the others.
 */
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { aws, paginate, physicalName } from '../lib/aws'
import { apiUrl } from '../lib/env'
import { lambdaLogGroup } from '../lib/cloudwatch'
import { isRecord } from '../lib/guards'
import { insights, metricSum, OPS_ENABLED, OPS_SKIP_REASON, opsWindow, recordsAt, writeEvidence } from '../lib/ops'
import { test } from '../lib/test'

/** The feedback processor's batching (lib/stacks/processing-stack-consolidated.ts). */
const PROCESSOR_BATCH = { size: 10, windowSeconds: 5 }
const MEMORY_WORKERS = ['voc-memory-scanner', 'voc-memory-extractor', 'voc-memory-retention'] as const
/** The VoC namespace's fallback / failure counters that must stay at zero. */
const ZERO_METRICS = ['FlexFallback', 'ModelFallback', 'AssistantSessionWriteFailed'] as const
/** Queue names that hold failures (DLQs and async failure destinations). */
const FAILURE_QUEUE = /(dlq|failures)/i

/** HTTP verbs API Gateway models as methods (OPTIONS is the CORS preflight on every resource). */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'any', 'x-amazon-apigateway-any-method'] as const

/** Routes retired in 3.00.00 (per-project MCP, autoseed). None may answer 2xx or 5xx. */
const RETIRED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/mcp'],
  ['GET', '/mcp/autoseed/x'],
  ['POST', '/mcp/autoseed/x'],
  ['GET', '/projects/x/autoseed'],
]

/** `{ apiId, stage }` from the stage URL `https://<id>.execute-api.<region>.amazonaws.com/<stage>`. */
function stageOf(url: string): { apiId: string; stage: string } {
  const parsed = new URL(url)
  return { apiId: parsed.hostname.split('.')[0] ?? '', stage: parsed.pathname.split('/').filter(Boolean)[0] ?? '' }
}

const methodKey = (method: string, route: string): string =>
  `${method.toUpperCase() === 'X-AMAZON-APIGATEWAY-ANY-METHOD' ? 'ANY' : method.toUpperCase()} ${route}`

/** Methods (not OPTIONS) the API DEFINITION holds now. */
function definedMethods(apiId: string): string[] {
  return paginate(['apigateway', 'get-resources', '--rest-api-id', apiId, '--embed', 'methods'], 'items')
    .filter(isRecord)
    .flatMap((r) => Object.keys(isRecord(r['resourceMethods']) ? r['resourceMethods'] : {})
      .filter((m) => m !== 'OPTIONS')
      .map((m) => methodKey(m, String(r['path']))))
    .sort()
}

/** Methods (not OPTIONS) the STAGE serves: its deployment's own export. */
function servedMethods(apiId: string, stage: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'voc-stage-export-'))
  const file = path.join(dir, 'oas30.json')
  try {
    aws(['apigateway', 'get-export', '--rest-api-id', apiId, '--stage-name', stage, '--export-type', 'oas30', file])
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const paths = isRecord(doc) && isRecord(doc['paths']) ? doc['paths'] : {}
    return Object.entries(paths)
      .flatMap(([route, ops]) => Object.keys(isRecord(ops) ? ops : {})
        .filter((m) => HTTP_METHODS.some((verb) => verb === m))
        .map((m) => methodKey(m, route)))
      .sort()
  } finally {
    try { unlinkSync(file) } catch { /* not written */ }
    rmdirSync(dir)
  }
}

function queueName(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1)
}

/** Every voc-* failure queue URL. */
function failureQueueUrls(): string[] {
  const listed = aws(['sqs', 'list-queues', '--queue-name-prefix', 'voc-'])
  const urls = isRecord(listed) && Array.isArray(listed['QueueUrls']) ? listed['QueueUrls'] : []
  return urls.filter((u): u is string => typeof u === 'string' && FAILURE_QUEUE.test(queueName(u)))
}

/** Visible + in-flight messages on a queue. */
function queueDepth(url: string): number {
  const body = aws(['sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names',
    'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'])
  const attrs = isRecord(body) && isRecord(body['Attributes']) ? body['Attributes'] : {}
  return Number(attrs['ApproximateNumberOfMessages'] ?? 0) + Number(attrs['ApproximateNumberOfMessagesNotVisible'] ?? 0)
}

test.describe('ops: post-deploy health (read-only)', () => {
  test.skip(!OPS_ENABLED, OPS_SKIP_REASON)

  test('every failure queue is empty', () => {
    const urls = failureQueueUrls()
    expect(urls.length, 'no failure queue found: wrong account or region?').toBeGreaterThan(0)
    const depth = Object.fromEntries(urls.map((url) => [queueName(url), queueDepth(url)]))
    writeEvidence('ops-postdeploy-queues.json', depth)
    expect(Object.entries(depth).filter(([, n]) => n > 0)).toStrictEqual([])
  })

  test('every voc-* CloudWatch alarm is OK', () => {
    const alarms = recordsAt(aws(['cloudwatch', 'describe-alarms', '--alarm-name-prefix', 'voc-']), 'MetricAlarms')
      .map((a) => ({ name: String(a['AlarmName']), state: String(a['StateValue']) }))
    writeEvidence('ops-postdeploy-alarms.json', alarms)
    expect(alarms.length, 'no voc-* alarm found: wrong account or region?').toBeGreaterThan(0)
    expect(alarms.filter((a) => a.state !== 'OK')).toStrictEqual([])
  })

  test('the feedback processor batches 10 records / 5 s', () => {
    const mappings = recordsAt(aws(['lambda', 'list-event-source-mappings', '--function-name',
      physicalName('voc-feedback-processor')]), 'EventSourceMappings')
      .map((m) => ({ batchSize: m['BatchSize'], windowSeconds: m['MaximumBatchingWindowInSeconds'], state: m['State'] }))
    writeEvidence('ops-postdeploy-processor-esm.json', mappings)
    expect(mappings).toStrictEqual([{ batchSize: PROCESSOR_BATCH.size, windowSeconds: PROCESSOR_BATCH.windowSeconds, state: 'Enabled' }])
  })

  test('the memory workers logged 0 ERROR lines', async () => {
    test.setTimeout(5 * 60_000)
    const window = opsWindow()
    const rows = await insights(MEMORY_WORKERS.map(lambdaLogGroup),
      'filter level = "ERROR" or @message like /\\[ERROR\\]/ or @message like /Traceback/ | stats count() as n by @log', window)
    const errors = Object.fromEntries(rows.map((r) => [r['@log']?.split('/').pop() ?? '', Number(r['n'] ?? 0)]))
    writeEvidence('ops-postdeploy-memory-errors.json', { window: window.label, errors })
    expect(Object.entries(errors).filter(([, n]) => n > 0)).toStrictEqual([])
  })

  test('the API stage serves exactly the API definition (no removed route left live)', () => {
    const { apiId, stage } = stageOf(apiUrl())
    const defined = definedMethods(apiId)
    const served = servedMethods(apiId, stage)
    const stale = served.filter((m) => !defined.includes(m))
    const missing = defined.filter((m) => !served.includes(m))
    writeEvidence('ops-postdeploy-stage-drift.json', { apiId, stage, defined: defined.length, served: served.length, stale, missing })
    expect(defined.length, 'no method found: wrong API or region?').toBeGreaterThan(20)
    expect(stale, `the stage still serves removed methods: run scripts/refresh-api-stage.sh`).toStrictEqual([])
    expect(missing, `the stage lags the definition: run scripts/refresh-api-stage.sh`).toStrictEqual([])
  })

  test('the routes retired in 3.00.00 answer neither 2xx nor 5xx', async () => {
    // Shape-valid for the gateway's MCP token authorizer, unknown to the server: no secret.
    const bearer = `Bearer voc_tok_0123456789abcdef_${'0'.repeat(64)}`
    const results: Array<{ route: string; status: number }> = []
    for (const [method, route] of RETIRED_ROUTES) {
      const res = await fetch(`${apiUrl()}${route}`, {
        method,
        headers: { Authorization: bearer, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) : undefined,
      })
      results.push({ route: `${method} ${route}`, status: res.status })
    }
    writeEvidence('ops-postdeploy-retired-routes.json', results)
    expect(results.filter((r) => r.status < 300 || r.status >= 500), 'a retired route is still served').toStrictEqual([])
  })

  for (const name of ZERO_METRICS) {
    test(`metric VoC/${name} is 0`, () => {
      const window = opsWindow()
      expect(metricSum('VoC', name, window), `${name} over the ${window.label}`).toBe(0)
    })
  }
})
