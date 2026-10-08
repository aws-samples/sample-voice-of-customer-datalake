/**
 * The stream's `invocation_cost` line: the same fields as the Python helper
 * (lambda/shared/invocation_cost.py), so one Logs Insights query covers every
 * function. Before it, voc-chat-stream had no CPU figure at all.
 */
import { describe, expect, it, vi } from 'vitest';

import { COST_LINE, invocationCostFields, MB_PER_VCPU, measureInvocationCost, memoryMb, type CostClock } from './invocation-cost.js';

function fakeClock(memory: number | undefined): CostClock & { lines: string[] } {
  const lines: string[] = [];
  let wall = 1_000;
  return {
    lines,
    // 40 ms user + 10 ms system between the two reads.
    cpuUsage: (previous) => (previous === undefined ? { user: 0, system: 0 } : { user: 40_000, system: 10_000 }),
    nowMs: () => {
      const now = wall;
      wall += 100;
      return now;
    },
    memoryMb: () => memory,
    log: (line) => lines.push(line),
  };
}

describe('invocationCostFields', () => {
  it('matches the Python formula and field names', () => {
    expect(invocationCostFields(1769, 50, 100)).toStrictEqual({
      message: 'invocation_cost', cpu_ms: 50, wall_ms: 100, function_memory_size: 1769, cpu_pct_of_allocation: 50,
    });
  });

  it('reads a larger share on a smaller function', () => {
    expect(invocationCostFields(1024, 50, 100).cpu_pct_of_allocation).toBeCloseTo((50 / (100 * (1024 / MB_PER_VCPU))) * 100, 1);
  });

  it('omits the share and size when memory is unknown, and the share when wall time is zero', () => {
    expect(invocationCostFields(undefined, 5, 10)).toStrictEqual({ message: COST_LINE, cpu_ms: 5, wall_ms: 10 });
    expect(invocationCostFields(512, 0, 0)).not.toHaveProperty('cpu_pct_of_allocation');
  });
});

describe('memoryMb', () => {
  it.each([
    ['1024', 1024], [undefined, undefined], ['', undefined], ['0', undefined], ['-1', undefined], ['1.5', undefined], ['abc', undefined],
  ])('%s -> %s', (raw, expected) => {
    expect(memoryMb(raw)).toBe(expected);
  });
});

describe('measureInvocationCost', () => {
  it('logs one JSON line per invocation with numbers only', async () => {
    const clock = fakeClock(1024);
    const handler = measureInvocationCost(async (event: { prompt: string }) => event.prompt.length, clock);

    await expect(handler({ prompt: 'a secret prompt' })).resolves.toBe(15);

    expect(clock.lines).toHaveLength(1);
    const line: unknown = JSON.parse(clock.lines[0] ?? '');
    expect(line).toStrictEqual({
      message: 'invocation_cost', cpu_ms: 50, wall_ms: 100, function_memory_size: 1024,
      cpu_pct_of_allocation: Math.round((50 / (100 * (1024 / MB_PER_VCPU))) * 1000) / 10,
    });
    expect(clock.lines[0]).not.toContain('secret');
  });

  it('still logs when the handler throws', async () => {
    const clock = fakeClock(1024);
    const handler = measureInvocationCost(async () => {
      throw new Error('boom');
    }, clock);

    await expect(handler()).rejects.toThrow('boom');
    expect(clock.lines).toHaveLength(1);
  });

  it('defaults to process.cpuUsage, performance.now and AWS_LAMBDA_FUNCTION_MEMORY_SIZE', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_MEMORY_SIZE', '1769');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 30_000, system: 20_000 });
    vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);
    try {
      await measureInvocationCost(async () => undefined)();
      expect(log.mock.calls).toStrictEqual([[JSON.stringify({
        message: 'invocation_cost', cpu_ms: 50, wall_ms: 250, function_memory_size: 1769, cpu_pct_of_allocation: 20,
      })]]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});
