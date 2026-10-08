/**
 * ops: every deployed voc-* Lambda within the sizing policy (docs/lambda-sizing.md).
 *
 * Given the operator's ambient AWS credentials (read-only calls only: lambda
 * list-functions, logs describe-log-groups, Logs Insights),
 * When the peak-memory (REPORT) and CPU (`invocation_cost`) queries run over the window,
 * Then no function's PEAK memory exceeds 70 % of MemorySize (60 % for the
 *   variable-payload class) and no function's CPU — the worse of the weighted and the
 *   p95 share, both over calls ≥ 100 ms only — exceeds 70 %; a function with fewer than
 *   20 such calls is "insufficient data" and a size pinned by Power Tuning waives the CPU
 *   rule (both listed, neither a breach); functions the window could not measure are
 *   printed and attached, not silently passed.
 *
 *   E2E_OPS=1 [E2E_OPS_HOURS=24 | E2E_OPS_SINCE=<deploy ISO time>] \
 *     npx playwright test -c playwright.ops.config.ts tests/ops-capacity.spec.ts
 *
 * Same evaluator as `voc-datalake/scripts/capacity/capacity-query.sh` (lib/sizing/capacity.ts).
 * Creates nothing, so there is no ledger entry and no cleanup.
 */
import { expect } from '@playwright/test'
import { breaches, collectCapacity, renderReport, type FunctionCapacity } from '../../../lib/sizing/capacity'
import { aws } from '../lib/aws'
import { OPS_ENABLED, OPS_SKIP_REASON, opsWindow, writeEvidence } from '../lib/ops'
import { test } from '../lib/test'

test.describe('ops: Lambda capacity under the sizing policy (read-only)', () => {
  test.skip(!OPS_ENABLED, OPS_SKIP_REASON)

  test('every voc-* Lambda: peak memory and CPU within policy', async ({}, testInfo) => {
    test.setTimeout(15 * 60_000)
    const window = opsWindow()
    const report = await collectCapacity(aws, { startSec: window.startSec, endSec: window.endSec })
    const table = renderReport(report)
    console.log(`Capacity (${window.label})\n${table}`)
    writeEvidence('ops-capacity.json', report)
    await testInfo.attach('ops-capacity.md', { body: table, contentType: 'text/markdown' })

    const unmeasured = report.functions.filter((f) => f.unmeasured.length > 0)
    const listed = (status: FunctionCapacity['cpuStatus']): string => report.functions.filter((f) => f.cpuStatus === status).map((f) => f.stem).join(', ') || 'none'
    testInfo.annotations.push({
      type: 'unmeasured',
      description: unmeasured.length === 0 ? 'none' : unmeasured.map((f) => `${f.stem} [${f.unmeasured.join(', ')}]`).join(', '),
    }, {
      type: 'cpu-insufficient-data',
      description: listed('insufficient-data'),
    }, {
      type: 'cpu-power-tuned',
      description: listed('power-tuned'),
    })

    expect(report.functions.length, 'no voc-* function was listed: wrong account or region?').toBeGreaterThan(0)
    // Neither "insufficient data" nor a Power Tuning pin is ever a CPU breach.
    expect(report.functions.filter((f) => f.cpuStatus !== 'judged' && f.breaches.some((b) => b.startsWith('CPU')))).toStrictEqual([])
    expect(breaches(report).map((f) => `${f.stem} (${f.memoryMb} MB): ${f.breaches.join('; ')}`)).toStrictEqual([])
  })
})
