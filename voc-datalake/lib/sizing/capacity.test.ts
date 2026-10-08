/**
 * The capacity evaluator: Insights rows → per-function verdicts under the sizing
 * policy (peak memory ≤ 70 % / 60 %; CPU, over calls ≥ 100 ms only, worse-of ≤ 70 %;
 * fewer than 20 such calls = insufficient data; a Power Tuning pin waives CPU), with
 * projection across a resize and an explicit list of what the window could not measure.
 */
import { describe, expect, it } from 'vitest';

import {
  breaches,
  collectCapacity,
  COST_QUERY,
  evaluateFunction,
  functionStem,
  insightsQuery,
  insightsRow,
  LONG_COST_QUERY,
  parseCpuStats,
  parseFunctions,
  parseMemoryStats,
  remedy,
  renderReport,
  REPORT_QUERY,
  type AwsRunner,
  type Measured,
} from './capacity';

const row = (fields: Record<string, string>): Array<{ field: string; value: string }> =>
  Object.entries(fields).map(([field, value]) => ({ field, value }));

const G = (stem: string): string => `/aws/lambda/${stem}-123456789012-us-west-2`;

describe('parsing', () => {
  it('strips the account and region from a physical name', () => {
    expect(functionStem('voc-ingestor-app_reviews_ios-123456789012-us-west-2')).toBe('voc-ingestor-app_reviews_ios');
    expect(functionStem('voc-metrics-api-123456789012-eu-central-1')).toBe('voc-metrics-api');
    expect(functionStem('voc-plain')).toBe('voc-plain');
  });

  it('keeps only voc-* functions and reads the custom log group when one is set', () => {
    const fns = parseFunctions({
      Functions: [
        { FunctionName: 'voc-b-123456789012-us-west-2', MemorySize: 512, Timeout: 30 },
        { FunctionName: 'voc-a-123456789012-us-west-2', MemorySize: 256, Timeout: 60, LoggingConfig: { LogGroup: 'Custom-Group' } },
        { FunctionName: 'other-fn', MemorySize: 128 },
        { FunctionName: 'voc-broken' },
        'garbage',
      ],
    });
    expect(fns).toStrictEqual([
      { name: 'voc-a-123456789012-us-west-2', stem: 'voc-a', memoryMb: 256, timeoutS: 60, logGroup: 'Custom-Group' },
      { name: 'voc-b-123456789012-us-west-2', stem: 'voc-b', memoryMb: 512, timeoutS: 30, logGroup: G('voc-b') },
    ]);
  });

  it('reads REPORT rows per MemorySize (bytes of 10^6)', () => {
    const stats = parseMemoryStats([
      row({ '@log': `123456789012:${G('voc-x')}`, '@memorySize': '512000000', n: '10', peakPct: '33.4' }),
      row({ '@log': `123456789012:${G('voc-x')}`, '@memorySize': '1024000000', n: '4', peakPct: '17' }),
      row({ '@log': 'broken' }),
    ]);
    expect(stats.get(G('voc-x'))).toStrictEqual([
      { memoryMb: 512, invocations: 10, peakPct: 33.4 },
      { memoryMb: 1024, invocations: 4, peakPct: 17 },
    ]);
  });

  it('joins the long-call figures onto the all-calls row of the same size', () => {
    const stats = parseCpuStats(
      [row({ '@log': `1:${G('voc-x')}`, function_memory_size: '512', n: '100' })],
      [row({ '@log': `1:${G('voc-x')}`, function_memory_size: '512', n: '20', weightedPct: '61.5', p95: '95.5' })],
    );
    expect(stats.get(G('voc-x'))).toStrictEqual([
      { memoryMb: 512, calls: 100, longCalls: 20, weightedPct: 61.5, p95LongPct: 95.5 },
    ]);
  });

  it('a size with no long call has neither figure', () => {
    const stats = parseCpuStats([row({ '@log': `1:${G('voc-x')}`, function_memory_size: '512', n: '100' })], []);
    expect(stats.get(G('voc-x'))).toStrictEqual([
      { memoryMb: 512, calls: 100, longCalls: 0, weightedPct: null, p95LongPct: null },
    ]);
  });

  it.each([
    [REPORT_QUERY, 'max(@maxMemoryUsed / @memorySize * 100)'],
    [REPORT_QUERY, 'by @log, @memorySize'],
    [COST_QUERY, 'message = "invocation_cost"'],
    [LONG_COST_QUERY, 'wall_ms >= 100'],
    [LONG_COST_QUERY, 'sum(cpu_pct_of_allocation * wall_ms) / sum(wall_ms)'],
    [LONG_COST_QUERY, 'pct(cpu_pct_of_allocation, 95)'],
  ])('query %s contains %s (peak memory by size; both CPU figures over long calls)', (query, fragment) => {
    expect(query).toContain(fragment);
  });

  it('the all-calls query computes no CPU figure (short calls count towards neither)', () => {
    expect(COST_QUERY).not.toContain('cpu_pct_of_allocation');
  });
});

describe('Logs Insights plumbing', () => {
  it('flattens a result row and drops malformed cells', () => {
    expect(insightsRow([{ field: 'n', value: '3' }, { field: 'x' }, 'junk'])).toStrictEqual({ n: '3' });
    expect(insightsRow('not a row')).toStrictEqual({});
  });

  it('queries at most 50 log groups at a time and concatenates the rows', async () => {
    const batches: number[] = [];
    const run: AwsRunner = (args) => {
      if (args[1] === 'start-query') {
        batches.push(args.indexOf('--start-time') - args.indexOf('--log-group-names') - 1);
        return { queryId: `q${batches.length}` };
      }
      return { status: 'Complete', results: [row({ n: '1' })] };
    };
    const groups = Array.from({ length: 120 }, (_, i) => `/aws/lambda/voc-${i}`);

    const rows = await insightsQuery(run, groups, REPORT_QUERY, { startSec: 1, endSec: 2, sleep: async () => undefined });

    expect(batches).toStrictEqual([50, 50, 20]);
    expect(rows).toHaveLength(3);
  });
});

describe('evaluateFunction', () => {
  const cpu = (weightedPct: number | null, p95LongPct: number | null, memoryMb = 1024, longCalls = 30) =>
    ({ memoryMb, calls: 500, weightedPct, longCalls, p95LongPct });

  it('passes a standard function at 69 % peak memory and 69 % CPU', () => {
    const verdict = evaluateFunction({ stem: 'voc-metrics-x', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 69 }], [cpu(60, 69)]);
    expect(verdict.breaches).toStrictEqual([]);
    expect(verdict.unmeasured).toStrictEqual([]);
    expect(verdict.cpuStatus).toBe('judged');
    expect(verdict.memoryCeilingPct).toBe(70);
  });

  it('breaches a variable-payload function at 61 % PEAK memory (60 % class)', () => {
    const verdict = evaluateFunction({ stem: 'voc-feedback-processor', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 61 }], [cpu(10, 10)]);
    expect(verdict.sizing).toBe('variable-payload');
    expect(verdict.breaches).toStrictEqual(['peak memory 61% > 60%']);
  });

  it('takes the WORSE of the long-call weighted and p95 shares', () => {
    const verdict = evaluateFunction({ stem: 'voc-scrapers-api', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 20 }], [cpu(40, 85)]);
    expect(verdict.cpu?.value.worstPct).toBe(85);
    expect(verdict.breaches).toStrictEqual(['CPU 85% > 70%']);
  });

  it('a long-call weighted share alone can breach', () => {
    const verdict = evaluateFunction({ stem: 'voc-scrapers-api', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 20 }], [cpu(75, 60)]);
    expect(verdict.breaches).toStrictEqual(['CPU 75% > 70%']);
  });

  it('short busy calls breach nothing: with no call ≥ 100 ms there is no figure to judge', () => {
    // The 2026-10-06 shape: thousands of 8–50 ms warm reads at ~90 % of the share.
    const verdict = evaluateFunction({ stem: 'voc-x', memoryMb: 512 },
      [{ memoryMb: 512, invocations: 9, peakPct: 20 }], [{ memoryMb: 512, calls: 4000, weightedPct: null, longCalls: 0, p95LongPct: null }]);
    expect(verdict.cpu?.value.worstPct).toBeNull();
    expect(verdict.cpuStatus).toBe('insufficient-data');
    expect(verdict.breaches).toStrictEqual([]);
  });

  const minimumCases: ReadonlyArray<[longCalls: number, status: string, breached: string[]]> = [
    [19, 'insufficient-data', []],
    [20, 'judged', ['CPU 95% > 70%']],
  ];
  it.each(minimumCases)(
    '%i long calls → %s (the minimum is 20)', (longCalls, status, breached) => {
      const verdict = evaluateFunction({ stem: 'voc-x', memoryMb: 512 },
        [{ memoryMb: 512, invocations: 9, peakPct: 20 }], [cpu(95, 95, 512, longCalls)]);
      expect(verdict.cpuStatus).toBe(status);
      expect(verdict.breaches).toStrictEqual(breached);
      expect(verdict.unmeasured).toStrictEqual([]);
    });

  it('a Power-Tuning-pinned size waives the CPU rule but not peak memory', () => {
    const pinned = evaluateFunction({ stem: 'voc-metrics-api', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 30 }], [cpu(92, 95)]);
    expect(pinned.cpuStatus).toBe('power-tuned');
    expect(pinned.powerTuning?.pickMb).toBe(1024);
    expect(pinned.breaches).toStrictEqual([]);

    const tooFull = evaluateFunction({ stem: 'voc-metrics-api', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 71 }], [cpu(92, 95)]);
    expect(tooFull.breaches).toStrictEqual(['peak memory 71% > 70%']);
  });

  it('the pin only covers the size it pinned: judged at another size, CPU is judged', () => {
    const verdict = evaluateFunction({ stem: 'voc-metrics-api', memoryMb: 512 },
      [{ memoryMb: 512, invocations: 9, peakPct: 30 }], [cpu(92, 95, 512)]);
    expect(verdict.cpuStatus).toBe('judged');
    expect(verdict.powerTuning).toBeNull();
    expect(verdict.breaches).toStrictEqual(['CPU 95% > 70%']);
  });

  it('projects a measurement at an older size to the judged size and says so', () => {
    // Production at 512 MB, repo at 1024 MB: 88 % CPU at 512 is 44 % at 1024.
    const verdict = evaluateFunction({ stem: 'voc-scrapers-api', memoryMb: 512 },
      [{ memoryMb: 512, invocations: 9, peakPct: 33.4 }], [cpu(88, 98, 512)], 1024);
    const expected: Measured<number> = { value: 16.7, measuredAtMb: 512, projected: true };
    expect(verdict.peakMemPct).toStrictEqual(expected);
    expect(verdict.cpu?.value.worstPct).toBe(49);
    expect(verdict.breaches).toStrictEqual([]);
  });

  it('prefers the stat at the judged size over an older one', () => {
    const verdict = evaluateFunction({ stem: 'voc-x', memoryMb: 1024 },
      [{ memoryMb: 512, invocations: 9, peakPct: 90 }, { memoryMb: 1024, invocations: 3, peakPct: 20 }], [cpu(10, 10)]);
    expect(verdict.peakMemPct).toStrictEqual({ value: 20, measuredAtMb: 1024, projected: false });
    expect(verdict.invocations).toBe(3);
  });

  it('lists what the window could not measure', () => {
    const none = evaluateFunction({ stem: 'voc-x', memoryMb: 512 }, [], []);
    expect(none.unmeasured).toStrictEqual(['memory', 'cpu']);
    expect(none.cpuStatus).toBe('unmeasured');
  });

  it('does not list CPU that is unmeasurable by design', () => {
    const authorizer = evaluateFunction({ stem: 'voc-mcp-token-authorizer', memoryMb: 128 },
      [{ memoryMb: 128, invocations: 9, peakPct: 50 }], []);
    expect(authorizer.unmeasured).toStrictEqual([]);
    expect(authorizer.cpuStatus).toBe('by-design');
    expect(authorizer.cpuNotMeasured).toMatch(/inline/);
  });
});

describe('remedy', () => {
  it.each([
    [{ memoryMb: 512, breaches: [] }, null],
    [{ memoryMb: 512, breaches: ['CPU 80% > 70%'] }, 'raise one step to 1024 MB'],
    [{ memoryMb: 1769, breaches: ['CPU 80% > 70%'] }, 'raise one step to 2048 MB (above 1 vCPU a step adds RAM, not CPU: Power Tuning first)'],
    [{ memoryMb: 3008, breaches: ['peak memory 90% > 70%'] }, 'at the top of the ladder: Power Tuning (docs/lambda-sizing.md)'],
  ])('%o → %s', (fn, expected) => {
    expect(remedy(fn)).toBe(expected);
  });
});

describe('collectCapacity (read-only calls only)', () => {
  function fakeAws(): { run: AwsRunner; calls: string[][] } {
    const calls: string[][] = [];
    const results: Record<string, unknown[]> = {
      [REPORT_QUERY]: [row({ '@log': `1:${G('voc-a')}`, '@memorySize': '512000000', n: '5', peakPct: '75' })],
      [COST_QUERY]: [row({ '@log': `1:${G('voc-a')}`, function_memory_size: '512', n: '5', weightedPct: '20' })],
      [LONG_COST_QUERY]: [],
    };
    const queries = new Map<string, string>();
    const run: AwsRunner = (args) => {
      calls.push([...args]);
      const [service, op] = args;
      if (service === 'lambda' && op === 'list-functions') {
        return { Functions: [
          { FunctionName: 'voc-a-123456789012-us-west-2', MemorySize: 512, Timeout: 30 },
          { FunctionName: 'voc-b-123456789012-us-west-2', MemorySize: 256, Timeout: 30 },
          { FunctionName: 'voc-c-123456789012-us-west-2', MemorySize: 256, Timeout: 30 },
        ] };
      }
      // voc-c's log group was never created: it must be left out of the query.
      if (op === 'describe-log-groups') return { logGroups: [{ logGroupName: G('voc-a') }, { logGroupName: G('voc-b') }] };
      if (op === 'start-query') {
        const id = `q${queries.size}`;
        queries.set(id, String(args[args.indexOf('--query-string') + 1]));
        return { queryId: id };
      }
      if (op === 'get-query-results') {
        const query = queries.get(String(args[args.indexOf('--query-id') + 1])) ?? '';
        return { status: 'Complete', results: results[query] ?? [] };
      }
      throw new Error(`unexpected call ${args.join(' ')}`);
    };
    return { run, calls };
  }

  const collect = (run: AwsRunner) => collectCapacity(run, { startSec: 1, endSec: 2, sleep: async () => undefined });

  it('judges every function, flags the breach and lists the unmeasured', async () => {
    const report = await collect(fakeAws().run);

    expect(report.functions.map((f) => f.stem)).toStrictEqual(['voc-a', 'voc-b', 'voc-c']);
    expect(breaches(report).map((f) => f.stem)).toStrictEqual(['voc-a']);
    expect(report.functions[1]?.unmeasured).toStrictEqual(['memory', 'cpu']);
  });

  it('queries only log groups that exist, and makes read-only calls only', async () => {
    const { run, calls } = fakeAws();
    await collect(run);

    const queried = calls.filter((c) => c[1] === 'start-query').map((c) => c.slice(c.indexOf('--log-group-names') + 1, c.indexOf('--start-time')));
    expect(queried).toStrictEqual([[G('voc-a'), G('voc-b')], [G('voc-a'), G('voc-b')], [G('voc-a'), G('voc-b')]]);
    expect(calls.map((c) => c[1]).every((op) => /^(list-|describe-|start-query|get-query-results)/.test(op ?? ''))).toBe(true);
  });

  it('renders the table, the breach and the unmeasured list', async () => {
    const table = renderReport(await collect(fakeAws().run));

    expect(table).toContain('| voc-a | standard | 512 | 5 | 75.0 (70) | — (0/5) | — | BREACH: peak memory 75% > 70% → raise one step to 1024 MB |');
    expect(table).toContain('Unmeasured in the window (2): voc-b [memory, cpu], voc-c [memory, cpu]');
    expect(table).toContain('CPU insufficient data (< 20 calls ≥ 100 ms, not a breach) (1): voc-a (0)');
    expect(table).toContain('CPU rule waived by a Power Tuning pin (peak memory still judged) (0): none');
  });

  it('lists a Power-Tuning-pinned function and says why its CPU passes', () => {
    const pinned = evaluateFunction({ stem: 'voc-agents-api', memoryMb: 1024 },
      [{ memoryMb: 1024, invocations: 9, peakPct: 20 }], [{ memoryMb: 1024, calls: 900, longCalls: 40, weightedPct: 91, p95LongPct: 95 }]);
    const table = renderReport({ window: { startSec: 1, endSec: 2 }, functions: [pinned] });

    expect(table).toContain('| voc-agents-api | standard | 1024 | 9 | 20.0 (70) | 91.0 (40/900) | 95.0 | OK (CPU: Power Tuning pin) |');
    expect(table).toContain('CPU rule waived by a Power Tuning pin (peak memory still judged) (1): voc-agents-api @ 1024 MB (2026-10-06)');
  });

  it('judges at a target size when one is given', async () => {
    const { run } = fakeAws();
    const report = await collectCapacity(run, { startSec: 1, endSec: 2, sleep: async () => undefined, targetSizes: { 'voc-a': 1024 } });
    expect(report.functions[0]?.peakMemPct).toStrictEqual({ value: 37.5, measuredAtMb: 512, projected: true });
    expect(breaches(report)).toStrictEqual([]);
  });

  it('fails loudly when a query does not complete', async () => {
    const run: AwsRunner = (args) => {
      if (args[1] === 'list-functions') return { Functions: [{ FunctionName: 'voc-a-123456789012-us-west-2', MemorySize: 512 }] };
      if (args[1] === 'describe-log-groups') return { logGroups: [{ logGroupName: G('voc-a') }] };
      if (args[1] === 'start-query') return { queryId: 'q' };
      return { status: 'Failed' };
    };
    await expect(collectCapacity(run, { startSec: 1, endSec: 2, sleep: async () => undefined })).rejects.toThrow('Insights query Failed');
  });
});
