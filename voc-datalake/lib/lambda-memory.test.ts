/**
 * Pins the MemorySize of EVERY AWS::Lambda::Function the default synth emits,
 * against the one sizing-policy table (lib/sizing/policy.ts, docs/lambda-sizing.md).
 *
 * Why a pin table. Lambda allocates CPU in proportion to memory (1,769 MB = one
 * vCPU). The owner rule (2026-10-18) is that no function exceeds 60 % of its CPU share (the
 * worse of the weighted share and the p95 share of calls ≥ 100 ms) and that PEAK
 * memory stays ≤ 60 % of MemorySize, every class (it was 70 % / 60 % until then).
 * Production capacity checks found the API Lambdas in RAISED_FOR_CPU over the ceiling
 * and they were raised a step (or two, where one step still left them above
 * it). A size is a cost AND a latency decision, so a change to any of them — up
 * or down — must be deliberate: this table fails on any drift, on a new function
 * nobody sized, and on a function that disappears.
 *
 * Note for anything ≥ 1,769 MB: the handlers are single-threaded Python, so
 * memory past one vCPU buys RAM, not speed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CAPPED_AT_ONE_VCPU_2026_10_23,
  CPU_NOT_MEASURED,
  DOUBLED_2026_10_20,
  MB_PER_VCPU,
  MEMORY_PEAK_MAX_PCT,
  MEMORY_SIZES,
  MEMORY_STEPS_MB,
  OPTIONAL_FUNCTION_SIZES,
  POWER_TUNED,
  RAISED_FOR_CPU,
  RAISED_FOR_PEAK_MEMORY,
  REPO_SIZES,
  UNCHANGED,
  VARIABLE_PAYLOAD,
  memoryCeilingPct,
  nextMemoryStep,
  powerTuningPin,
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
      Runtime: z.string().optional(),
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


/** The Power Tuning records the owner has moved off (history only). */
const SUPERSEDED_PINS = Object.entries(POWER_TUNED).filter(([, r]) => r.superseded !== undefined);

const synthed = synthApp();
afterAll(cleanupAssemblyDirs);

interface SynthesizedFunction {
  readonly memorySize: number | null;
  readonly runtime: string;
}

/** Every synthesized function by pin key: its MemorySize (null = Lambda's default) and Runtime. */
function synthesizedFunctions(): Record<string, SynthesizedFunction> {
  const functions: Record<string, SynthesizedFunction> = {};
  for (const stackName of synthed.stackNames) {
    const { Resources } = ResourcesSchema.parse(synthed.template(stackName));
    for (const [logicalId, resource] of Object.entries(Resources)) {
      if (resource.Type !== 'AWS::Lambda::Function') continue;
      const key = nameStem(resource.Properties?.FunctionName) ?? `${stackName}/${logicalId}`;
      if (key in functions) throw new Error(`two functions map to the pin key ${key}`);
      functions[key] = { memorySize: resource.Properties?.MemorySize ?? null, runtime: resource.Properties?.Runtime ?? '' };
    }
  }
  return functions;
}

const SYNTHESIZED = synthesizedFunctions();

function synthesizedMemorySizes(): Record<string, number | null> {
  return Object.fromEntries(Object.entries(SYNTHESIZED).map(([key, fn]) => [key, fn.memorySize]));
}

/** MemorySize of every synthesized Python function, by pin key. */
function synthesizedPythonSizes(): Record<string, number | null> {
  return Object.fromEntries(Object.entries(SYNTHESIZED)
    .filter(([, fn]) => fn.runtime.startsWith('python')).map(([key, fn]) => [key, fn.memorySize]));
}

describe('Lambda memory sizes (sizing policy: peak memory and CPU ≤ 60 %, every class)', { timeout: SYNTH_TIMEOUT_MS }, () => {
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
  // A standing pin waives the CPU rule, so it must BE the size the synth emits; a superseded
  // one (owner, 2026-10-18) is history, and the synth emits the size it moved to — one or two
  // rungs above the pin, never past one vCPU — doubled on 2026-10-20 (metrics, projects) and capped back at one vCPU on 2026-10-23
  // (CAPPED_AT_ONE_VCPU_2026_10_23). A pin may sit above the pick only where the record
  // says why (ballots,
  // kept at 1,024 MB from before the 2026-10-07 refinement), never below it, and never
  // above one vCPU without measured gains (none were).
  it.each(Object.entries(POWER_TUNED))('%s is emitted at its Power Tuning pin, the size that superseded it, or one vCPU (capped 2026-10-23)', (stem, record) => {
    const expected = stem in CAPPED_AT_ONE_VCPU_2026_10_23 ? MB_PER_VCPU : record.superseded?.toMb ?? record.pinnedMb;
    expect(MEMORY_SIZES[stem], stem).toBe(expected);
    expect(MEMORY_STEPS_MB).toContain(record.pinnedMb);
  });

  it.each(SUPERSEDED_PINS.filter(([stem]) => stem in DOUBLED_2026_10_20))(
    '%s was doubled on 2026-10-20 from the size that superseded its pin', (stem, record) => {
      expect(DOUBLED_2026_10_20[stem], stem).toBe(record.superseded?.toMb);
    });

  // The 2026-10-18 raise went up the ladder, never down, and stopped at one vCPU: one rung, or two where
  // one rung still projected over 60 % (lib/sizing/policy.ts RAISED_FOR_CPU comments).
  it.each(SUPERSEDED_PINS)(
    '%s was superseded by a raise of one or two rungs, at most one vCPU', (_stem, record) => {
      const oneStep = nextMemoryStep(record.pinnedMb);
      expect([oneStep, nextMemoryStep(oneStep)]).toContain(record.superseded?.toMb);
      expect(record.superseded?.toMb ?? 0).toBeLessThanOrEqual(MB_PER_VCPU);
    });

  it.each(Object.entries(POWER_TUNED))('%s is pinned between its pick and one vCPU', (_stem, record) => {
    expect(record.pinnedMb).toBeGreaterThanOrEqual(record.pickMb);
    expect(record.pinnedMb).toBeLessThanOrEqual(MB_PER_VCPU);
    expect(Object.keys(record.durationMs).map(Number)).toContain(record.pickMb);
  });

  it('the six 2026-10-06 Power Tuning decisions are recorded, each superseded on 2026-10-18', () => {
    expect(Object.fromEntries(Object.entries(POWER_TUNED).map(([stem, r]) =>
      [stem, [r.date, r.pickMb, r.pinnedMb, r.superseded?.date, r.superseded?.toMb]]))).toStrictEqual({
      'voc-ballots-api': ['2026-10-06', 512, 1024, '2026-10-18', 1769],
      'voc-settings-api': ['2026-10-06', 512, 512, '2026-10-18', 1024],
      'voc-metrics-api': ['2026-10-06', 1024, 1024, '2026-10-18', 1536],
      'voc-projects-api': ['2026-10-06', 1024, 1024, '2026-10-18', 1536],
      'voc-memory-api': ['2026-10-06', 1024, 1024, '2026-10-18', 1536],
      'voc-agents-api': ['2026-10-06', 1024, 1024, '2026-10-18', 1769],
    });
  });

  it.each(SUPERSEDED_PINS)(
    'superseded %s waives the CPU rule at no size (neither its old pin nor its new size)', (stem, record) => {
      expect(powerTuningPin(stem, record.pinnedMb)).toBeNull();
      expect(powerTuningPin(stem, record.superseded?.toMb ?? record.pinnedMb)).toBeNull();
    });

  // 2026-10-20: the eight over 60 % CPU in the 24 h window were doubled — exactly ×2, not a rung.
  it('the 2026-10-20 doubling covers exactly the eight functions over the CPU ceiling', () => {
    expect(Object.keys(DOUBLED_2026_10_20).sort(byCodeUnit)).toStrictEqual([
      'voc-agent-heartbeat', 'voc-briefing', 'voc-integrations-api', 'voc-logs-api', 'voc-memory-scanner',
      'voc-metrics-api', 'voc-projects-api', 'voc-radar-api',
    ]);
  });

  // The owner's table (docs/lambda-sizing.md), pinned literally: from → to.
  it.each([
    ['voc-radar-api', 1024, 2048], ['voc-integrations-api', 1536, 3072], ['voc-projects-api', 1536, 3072],
    ['voc-metrics-api', 1536, 3072], ['voc-memory-scanner', 1536, 3072], ['voc-logs-api', 1769, 3538],
    ['voc-briefing', 1769, 3538], ['voc-agent-heartbeat', 1769, 3538],
  ])('%s was doubled from %i to %i MB on 2026-10-20, then capped at one vCPU on 2026-10-23', (stem, fromMb, toMb) => {
    expect(DOUBLED_2026_10_20[stem], stem).toBe(fromMb);
    expect(CAPPED_AT_ONE_VCPU_2026_10_23[stem], stem).toBe(toMb);
    expect(RAISED_FOR_CPU[stem], stem).toBe(MB_PER_VCPU);
    expect(MEMORY_STEPS_MB).toContain(fromMb);
  });

  // Since 2026-10-23: Python runs one core, so a size above one vCPU buys no speed (policy.ts).
  it.each(Object.entries(synthesizedPythonSizes()))('Python function %s is at most one vCPU (%s MB)', (key, memorySize) => {
    expect(memorySize ?? 128, key).toBeLessThanOrEqual(MB_PER_VCPU);
  });

  it('the 2026-10-23 cap covers exactly the functions the 2026-10-20 doubling raised', () => {
    expect(Object.keys(CAPPED_AT_ONE_VCPU_2026_10_23).sort(byCodeUnit)).toStrictEqual(Object.keys(DOUBLED_2026_10_20).sort(byCodeUnit));
  });

  it.each(Object.entries(OPTIONAL_FUNCTION_SIZES))(
    'context-flag %s is sized on the ladder, outside the default-synth table', (stem, memorySize) => {
      expect(MEMORY_SIZES, stem).not.toHaveProperty([stem]);
      expect(MEMORY_STEPS_MB).toContain(memorySize);
      expect(REPO_SIZES[stem]).toBe(memorySize);
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

  it('applies 60 % to every class (owner, 2026-10-18)', () => {
    expect(MEMORY_PEAK_MAX_PCT).toStrictEqual({ standard: 60, 'variable-payload': 60 });
  });

  it('computes CPU shares against one vCPU at 1,769 MB', () => {
    expect(MB_PER_VCPU).toBe(1769);
  });

  it.each([
    ['voc-feedback-processor', 60], ['voc-manual-import-api', 60], ['voc-metrics-api', 60], ['voc-not-a-function', 60],
  ])('%s has a %i %% peak-memory ceiling', (stem, ceiling) => {
    expect(memoryCeilingPct(stem)).toBe(ceiling);
  });

  it.each([[256, 512], [512, 1024], [1024, 1536], [3008, 3008]])('%i MB steps up to %i MB', (from, to) => {
    expect(nextMemoryStep(from)).toBe(to);
  });
});
