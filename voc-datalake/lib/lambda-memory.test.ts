/**
 * Pins the MemorySize of EVERY AWS::Lambda::Function the default synth emits,
 * against the one sizing-policy table (lib/sizing/policy.ts, docs/lambda-sizing.md).
 *
 * Why a pin table. Lambda allocates CPU in proportion to memory (1,769 MB = one
 * vCPU). The owner rule is that no function exceeds 70 % of its CPU share (the
 * worse of the weighted share and the p95 share of calls ≥ 100 ms) and that PEAK
 * memory stays ≤ 70 % of MemorySize — ≤ 60 % for variable-payload functions.
 * Production capacity checks found the API Lambdas in RAISED_FOR_CPU at 76–143 %
 * CPU and they were raised a step (or two, where one step still left them above
 * 70 %). A size is a cost AND a latency decision, so a change to any of them — up
 * or down — must be deliberate: this table fails on any drift, on a new function
 * nobody sized, and on a function that disappears.
 *
 * Note for anything ≥ 1,769 MB: the handlers are single-threaded Python, so
 * memory past one vCPU buys RAM, not speed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CPU_NOT_MEASURED,
  MB_PER_VCPU,
  MEMORY_PEAK_MAX_PCT,
  MEMORY_SIZES,
  MEMORY_STEPS_MB,
  POWER_TUNED,
  RAISED_FOR_CPU,
  RAISED_FOR_PEAK_MEMORY,
  UNCHANGED,
  VARIABLE_PAYLOAD,
  memoryCeilingPct,
  nextMemoryStep,
} from './sizing/policy';
import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

/** Functions a non-default context flag adds (so they are classified but never pinned). */
const OPTIONAL_FUNCTIONS = new Set(['voc-fixture-provider']);

const ResourcesSchema = z.object({
  Resources: z.record(z.string(), z.object({
    Type: z.string(),
    Properties: z.object({
      FunctionName: z.unknown().optional(),
      MemorySize: z.number().optional(),
    }).loose().optional(),
  }).loose()),
}).loose();

/** `voc-x-${AccountId}-${Region}` is synthesized as Fn::Join ['', ['voc-x-', Ref, '-', Ref]]. */
const JoinedNameSchema = z.object({
  'Fn::Join': z.tuple([z.literal(''), z.array(z.unknown()).min(1)]),
});

function nameStem(functionName: unknown): string | undefined {
  if (typeof functionName === 'string') return functionName;
  const joined = JoinedNameSchema.safeParse(functionName);
  if (!joined.success) return undefined;
  const head = joined.data['Fn::Join'][1][0];
  return typeof head === 'string' ? head.replace(/-$/, '') : undefined;
}

const synthed = synthApp();
afterAll(cleanupAssemblyDirs);

function synthesizedMemorySizes(): Record<string, number | null> {
  const sizes: Record<string, number | null> = {};
  for (const stackName of synthed.stackNames) {
    const { Resources } = ResourcesSchema.parse(synthed.template(stackName));
    for (const [logicalId, resource] of Object.entries(Resources)) {
      if (resource.Type !== 'AWS::Lambda::Function') continue;
      const key = nameStem(resource.Properties?.FunctionName) ?? `${stackName}/${logicalId}`;
      if (key in sizes) throw new Error(`two functions map to the pin key ${key}`);
      sizes[key] = resource.Properties?.MemorySize ?? null;
    }
  }
  return sizes;
}

describe('Lambda memory sizes (sizing policy: peak memory and CPU ≤ 70 %, variable payload ≤ 60 %)', { timeout: SYNTH_TIMEOUT_MS }, () => {
  const actual = synthesizedMemorySizes();

  it('pins every synthesized function, and only those', () => {
    expect(Object.keys(actual).sort(byCodeUnit)).toStrictEqual(Object.keys(MEMORY_SIZES).sort(byCodeUnit));
  });

  it.each(Object.entries(MEMORY_SIZES))('%s has MemorySize %s', (key, memorySize) => {
    expect(actual[key], key).toBe(memorySize);
  });

  // Guards the table itself: lowering a CPU-raised function back to 256 MB in BOTH
  // the stack and the pin above would otherwise pass silently.
  it.each(Object.entries(RAISED_FOR_CPU))('%s stays above the 256 MB it saturated', (_key, memorySize) => {
    expect(memorySize).toBeGreaterThanOrEqual(512);
  });

  it('keeps each function in exactly one pin group', () => {
    const groups = [Object.keys(UNCHANGED), Object.keys(RAISED_FOR_CPU), Object.keys(RAISED_FOR_PEAK_MEMORY)];
    const all = groups.flat();
    expect(new Set(all).size, 'a key appears in two groups').toBe(all.length);
  });

  it.each(Object.entries(RAISED_FOR_PEAK_MEMORY))('%s was raised to a rung of the memory ladder', (_key, memorySize) => {
    expect(MEMORY_STEPS_MB).toContain(memorySize);
  });

  // Power Tuning (POWER_TUNED in policy.ts): the tool's pick and the size pinned from it.
  // A pin waives the CPU rule, so it must BE the size the synth emits, and may sit above
  // the pick only where the record says why (ballots, kept at 1,024 MB from before the
  // 2026-10-07 refinement, when the CPU rule still rejected 512), never below it, and
  // never above one vCPU without measured gains (none were).
  it.each(Object.entries(POWER_TUNED))('%s is emitted at its Power Tuning pin', (stem, record) => {
    expect(MEMORY_SIZES[stem], stem).toBe(record.pinnedMb);
    expect(MEMORY_STEPS_MB).toContain(record.pinnedMb);
  });

  it.each(Object.entries(POWER_TUNED))('%s is pinned between its pick and one vCPU', (_stem, record) => {
    expect(record.pinnedMb).toBeGreaterThanOrEqual(record.pickMb);
    expect(record.pinnedMb).toBeLessThanOrEqual(MB_PER_VCPU);
    expect(Object.keys(record.durationMs).map(Number)).toContain(record.pickMb);
  });

  it('the six 2026-10-06 Power Tuning decisions are recorded', () => {
    expect(Object.fromEntries(Object.entries(POWER_TUNED).map(([stem, r]) => [stem, [r.date, r.pickMb, r.pinnedMb]]))).toStrictEqual({
      'voc-ballots-api': ['2026-10-06', 512, 1024],
      'voc-settings-api': ['2026-10-06', 512, 512],
      'voc-metrics-api': ['2026-10-06', 1024, 1024],
      'voc-projects-api': ['2026-10-06', 1024, 1024],
      'voc-memory-api': ['2026-10-06', 1024, 1024],
      'voc-agents-api': ['2026-10-06', 1024, 1024],
    });
  });
});

describe('sizing classification', () => {
  it.each(Object.keys(VARIABLE_PAYLOAD))('variable-payload %s is a pinned function', (stem) => {
    expect(MEMORY_SIZES, stem).toHaveProperty([stem]);
  });

  it.each(Object.keys(CPU_NOT_MEASURED).filter((stem) => !OPTIONAL_FUNCTIONS.has(stem)))(
    'CPU-not-measured %s is a pinned function', (stem) => {
      expect(MEMORY_SIZES, stem).toHaveProperty([stem]);
    });

  it('applies 60 % to the variable-payload class and 70 % to everything else', () => {
    expect(MEMORY_PEAK_MAX_PCT).toStrictEqual({ standard: 70, 'variable-payload': 60 });
  });

  it('computes CPU shares against one vCPU at 1,769 MB', () => {
    expect(MB_PER_VCPU).toBe(1769);
  });

  it.each([
    ['voc-feedback-processor', 60], ['voc-manual-import-api', 60], ['voc-metrics-api', 70], ['voc-not-a-function', 70],
  ])('%s has a %i %% peak-memory ceiling', (stem, ceiling) => {
    expect(memoryCeilingPct(stem)).toBe(ceiling);
  });

  it.each([[256, 512], [512, 1024], [1024, 1536], [3008, 3008]])('%i MB steps up to %i MB', (from, to) => {
    expect(nextMemoryStep(from)).toBe(to);
  });
});
