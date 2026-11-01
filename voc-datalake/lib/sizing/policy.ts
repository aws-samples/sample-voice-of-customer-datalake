/**
 * The Lambda sizing policy, in ONE place (docs/lambda-sizing.md).
 *
 * Read by:
 * - lib/lambda-memory.test.ts — pins every synthesized function's MemorySize to
 *   `MEMORY_SIZES` below, and checks the classification covers exactly those;
 * - lib/sizing/capacity.ts — evaluates production measurements against the rule
 *   (scripts/capacity/capacity-query.sh, frontend/e2e/tests/ops-capacity.spec.ts).
 *
 * THE RULE (owner-approved 2026-10-18: 60 % for memory and CPU, every class). AWS
 * publishes no utilisation target; 60 % is our trigger for a raise. History: 2026-10-05
 * set 70 % (60 % for variable-payload peak memory); 2026-10-07 refined the CPU half to
 * calls ≥ 100 ms; 2026-10-18 lowered both ceilings to 60 % for every class.
 * - Memory: PEAK (`max_memory_used` over the window, not p95) ≤ 60 % of MemorySize. The
 *   variable-payload class (memory grows with what a caller sends or a batch holds) is
 *   still listed, with why, but now shares the ceiling.
 * - CPU: over the invocations that ran ≥ 100 ms only, the worse of (a) the wall-weighted
 *   share and (b) the p95 share, ≤ 60 %. A share is CPU time / (wall time × MemorySize /
 *   1,769 MB), from the `invocation_cost` line every function logs
 *   (lambda/shared/invocation_cost.py, lambda/stream/src/lib/invocation-cost.ts).
 *   Short calls are excluded from BOTH figures: an 8–50 ms warm read is CPU-busy for
 *   its whole wall time at any size, so its share says nothing about whether more
 *   memory would help (Power Tuning 2026-10-06: 87–95 % weighted at 1,024 MB on six
 *   functions whose duration did not improve with more memory).
 * - Fewer than CPU_MIN_LONG_CALLS such calls in the window: CPU is "insufficient
 *   data" — listed, not a breach.
 * - A size pinned by Power Tuning (POWER_TUNED) overrides the CPU rule; only its peak
 *   memory is judged. The curve measured what the share only estimates. A pin covers
 *   only the size it pinned, and a superseded pin (the owner moved the function off
 *   it) waives nothing: every 2026-10-06 pin was superseded on 2026-10-18.
 *
 * Keep this file dependency-free: the e2e package imports it too (no zod there).
 */

/** Lambda allocates one full vCPU at 1,769 MB; single-threaded Python gains nothing above it. */
export const MB_PER_VCPU = 1769;

/** The owner's ceiling (2026-10-18): one number for memory and CPU, every class. */
const SIZING_CEILING_PCT = 60;

/** CPU ceiling, % of the function's share (both the weighted and the p95 figure, over long calls). */
export const CPU_MAX_PCT = SIZING_CEILING_PCT;

/** Only invocations at least this long count towards either CPU figure. */
export const CPU_LONG_CALL_MS = 100;

/** Fewer long calls than this in the window: CPU is "insufficient data", not judged. */
export const CPU_MIN_LONG_CALLS = 20;

export type SizingClass = 'standard' | 'variable-payload';

/** Peak-memory ceiling by class, % of MemorySize (60 % for both since 2026-10-18; standard was 70 %). */
export const MEMORY_PEAK_MAX_PCT: Readonly<Record<SizingClass, number>> = {
  standard: SIZING_CEILING_PCT,
  'variable-payload': SIZING_CEILING_PCT,
};

/**
 * The memory ladder a raise climbs one rung at a time ("one step"). 1,769 MB is
 * one vCPU; above it a Python handler buys RAM, not speed.
 */
export const MEMORY_STEPS_MB: readonly number[] = [128, 256, 512, 1024, 1536, 1769, 2048, 3008];

/** The next rung above `memoryMb` (the size itself when it is already at the top). */
export function nextMemoryStep(memoryMb: number): number {
  return MEMORY_STEPS_MB.find((step) => step > memoryMb) ?? memoryMb;
}

/**
 * Variable-payload functions (the 60 % class before every class moved to 60 %), with why. Physical-name stems
 * (`voc-x`, without `-<account>-<region>`). Every other function is `standard`.
 */
export const VARIABLE_PAYLOAD: Readonly<Record<string, string>> = {
  'voc-manual-import-api': 'parses a pasted or uploaded import inside the request',
  'voc-manual-import-processor': 'holds a whole manual-import batch',
  'voc-feedback-processor': 'SQS batch of up to 10 reviews of any length, processed concurrently',
  'voc-aggregation-processor': 'DynamoDB Streams batch',
  'voc-memory-extractor': 'SQS batch of conversation and agent-run transcripts',
  'voc-job-document-generator': 'feedback corpus in the prompt plus a long model answer',
  'voc-job-persona-generator': 'feedback corpus in the prompt plus several personas',
  'voc-job-persona-importer': 'an uploaded persona document',
  'voc-job-document-merger': 'merges every version of a document series',
  'voc-category-reprocess': 'pages through stored feedback and raw objects',
  'voc-ingestor-s3_import': 'reads whole uploaded files from S3',
  'voc-product-doc-extractor': 'reads an uploaded document or image (up to the size cap)',
};

/**
 * Functions that never log `invocation_cost`, with why. The capacity report lists
 * them as "CPU not measured (by design)" rather than as a measurement gap.
 */
export const CPU_NOT_MEASURED: Readonly<Record<string, string>> = {
  'voc-cdn-signing-keys': 'deploy-time custom resource (Node), runs once per deploy',
  'voc-admin-bootstrap': 'deploy-time custom resource, runs once per deploy',
  'voc-fixture-provider': 'deploy-time verification-fixture custom resource (only with the fixture context flag)',
};

/** The class of a function by stem (anything unlisted is `standard`). */
export function sizingClass(stem: string): SizingClass {
  return Object.prototype.hasOwnProperty.call(VARIABLE_PAYLOAD, stem) ? 'variable-payload' : 'standard';
}

/** The peak-memory ceiling (%) that applies to a function. */
export function memoryCeilingPct(stem: string): number {
  return MEMORY_PEAK_MAX_PCT[sizingClass(stem)];
}

// ── MemorySize of every synthesized function ────────────────────────────────
// Keys are the physical-name stem for named functions and `<stack>/<logicalId>`
// for the CDK-provided singletons that carry no FunctionName. `null` means the
// template omits MemorySize (Lambda's 128 MB default). A size is a cost AND a
// latency decision, so lib/lambda-memory.test.ts fails on ANY drift from these.

// The 2026-10-18 measurement every raise of that date cites (docs/lambda-sizing.md):
// Production, 2026-10-04 → 2026-10-18, `scripts/capacity/capacity-query.sh --hours 336`; figures are the
// CPU p95 share over calls ≥ 100 ms at the old size unless noted. The rule since 2026-10-18: raise every
// function over the new 60 % ceiling (or with peak memory near it) one step, Power Tuning pins included.

/**
 * 2026-10-20: DOUBLE the memory of every function over
 * the 60 % CPU ceiling in the 24 h window 2026-10-19T03:31Z → 2026-10-20T03:31Z, every invocation at the size it
 * was doubled from (docs/lambda-sizing.md "Doubled under the 60 % rule"); RAISED_FOR_CPU took
 * twice it. Not rungs of MEMORY_STEPS_MB: a doubling is a fixed ×2, not "one
 * step". Above 1,769 MB a single-threaded handler gets no more CPU, so for the share above one vCPU the doubling
 * lowers the measured share rather than speeding the code: re-measure, and Power Tune or make the code cheaper
 * if one still breaches.
 */
export const DOUBLED_2026_10_20: Readonly<Record<string, number>> = {
  'voc-radar-api': 1024, //        77.3 / 92.1 % (weighted / p95, calls ≥ 100 ms)
  'voc-integrations-api': 1536, // 49.7 / 75.8 %
  'voc-projects-api': 1536, //     56.0 / 75.4 %
  'voc-metrics-api': 1536, //      62.7 / 74.9 %
  'voc-memory-scanner': 1536, //   58.9 / 70.3 %
  'voc-logs-api': 1769, //         61.0 / 79.8 %
  'voc-briefing': 1769, //         63.8 / 72.6 %
  'voc-agent-heartbeat': 1769, //  61.0 / 69.5 %
};

/**
 * Since 5.27.00: no single-threaded Python function sits above one vCPU. Every Python
 * handler runs one core (the GIL; `shared/concurrency.py` threads only overlap network waits), so memory above
 * 1,769 MB bought no speed: the 2026-10-20 doubling only lowered the measured share. The CPU behind those
 * breaches was made cheaper instead (docs/lambda-sizing.md "Back to one vCPU"): clients built during INIT
 * (`shared/warm_init.py`), one-pass DynamoDB item decoding (`shared/dynamodb_fast_items.py`), projected metric
 * walks, counted log summaries. Stem → the size it had before (the doubled size, history); RAISED_FOR_CPU
 * holds MB_PER_VCPU (`cappedOn20261023`).
 * lib/lambda-memory.test.ts fails on any Python function above MB_PER_VCPU.
 */
export const CAPPED_AT_ONE_VCPU_2026_10_23: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(DOUBLED_2026_10_20).map(([stem, fromMb]) => [stem, 2 * fromMb]),
);

/** The 2026-10-23 size of a function the cap brought back: one vCPU (it must be in CAPPED_AT_ONE_VCPU_2026_10_23). */
function cappedOn20261023(stem: string): number {
  if (!(stem in CAPPED_AT_ONE_VCPU_2026_10_23)) throw new Error(`${stem} is not in CAPPED_AT_ONE_VCPU_2026_10_23`);
  return MB_PER_VCPU;
}

/**
 * Raised for CPU per the capacity evidence (2.17.00; the 3.00.00 production check,
 * voc-e2e/verify/3.00.00/CAPACITY-REPORT.md; the 2026-10-18 check above): each was over
 * the ceiling of its day and went up one rung (two where one still left it over); the eight in
 * DOUBLED_2026_10_20 were then doubled on 2026-10-20, and brought back to one vCPU on 2026-10-23
 * (CAPPED_AT_ONE_VCPU_2026_10_23).
 * Upsize-only: nothing is lowered towards a Power Tuning pick, so a resize never slows a function.
 *
 * The six marked [PT] were sized by AWS Lambda Power Tuning on 2026-10-06; those pins
 * (POWER_TUNED below) were superseded on 2026-10-18 and no longer waive the CPU rule.
 */
export const RAISED_FOR_CPU: Readonly<Record<string, number>> = {
  // ── Power Tuning pins superseded 2026-10-18 (owner: raise regardless of the curves) ──
  // 256 MB at 143 % → 1024 (two steps; [PT] picked 512); 2026-10-18: 1024 MB at 90.9 % → 1769 (one vCPU:
  // projected 60.6 % at 1536, owner: every function under 60 %).
  'voc-ballots-api': 1769,
  // 256 MB at 129 % → 512 ([PT] picked 512); 2026-10-18: 512 MB at 96.4 % → 1024.
  'voc-settings-api': 1024,
  // 512 MB at 102 % → 1024 ([PT] picked 1024); 2026-10-18: 1024 MB at 94.6 % → 1769 (one vCPU: projected
  // 63.1 % at 1536).
  'voc-agents-api': 1769,
  // 512 MB at 88 % → 1024 ([PT] picked 1024, 40.8 → 21.9 ms, flat above); 2026-10-18: 1024 MB at 83.1 % → 1536;
  // 2026-10-20: 1536 MB at 62.7 / 74.9 % → 3072 (DOUBLED_2026_10_20).
  'voc-metrics-api': cappedOn20261023('voc-metrics-api'), // 1769
  // 512 MB at 76 % → 1024 ([PT] picked 1024, 54.0 → 36.5 ms, flat above); 2026-10-18: 1024 MB at 82.1 % → 1536;
  // 2026-10-20: 1536 MB at 56.0 / 75.4 % → 3072 (DOUBLED_2026_10_20).
  'voc-projects-api': cappedOn20261023('voc-projects-api'), // 1769
  // 512 MB at 85 % → 1024 ([PT] picked 1024); 2026-10-18: 1024 MB at 73.7 % → 1536. SnapStart (live alias).
  'voc-memory-api': 1536,
  // ── over 70 % on 2026-10-18 ──
  'voc-chat-api': 1024, //           512 MB at 94 % (2.17.00)
  // 256 MB at 92 % → 512 (2.17.00); 2026-10-18: 512 MB at 91.7 % → 1024.
  'voc-data-explorer-api': 1024,
  // 256 → 512 (2.17.00) → 1024 (3.00.00: 105.1 % p95 at 512 MB); 2026-10-18: 1024 MB at 94.3 % → 1769
  // (one vCPU: projected 62.9 % at 1536). CPU-bound: if 1769 still breaches, Power Tune it. 2026-10-20: 1769 MB
  // at 61.0 / 79.8 % → 3538 (DOUBLED_2026_10_20).
  'voc-logs-api': cappedOn20261023('voc-logs-api'), // 1769
  // 256 → 512 (2.17.00) → 1024 (3.00.00: 88.5 % p95 at 512 MB); 2026-10-18: 1024 MB at 79.4 % → 1536;
  // 2026-10-20: 1536 MB at 49.7 / 75.8 % → 3072 (DOUBLED_2026_10_20). SnapStart (live alias).
  'voc-integrations-api': cappedOn20261023('voc-integrations-api'), // 1769
  // 256 → 512 (2.17.00) → 1024 (3.00.00: 79.9 % p95 at 512 MB, mostly first calls after a restore).
  'voc-feedback-form-api': 1024,
  // 256 → 512 (2.17.00) → 1024 (3.00.00: 98.0 % p95 at 512 MB over 11 long calls).
  'voc-mcp-tokens-api': 1024,
  // 2026-10-18: 256 MB at 80.7 % → 512.
  'voc-mcp-global-api': 512,
  // 2026-10-18: 512 MB at 93.9 % → 1024; 2026-10-20: 1024 MB at 77.3 / 92.1 % → 2048 (DOUBLED_2026_10_20).
  'voc-radar-api': cappedOn20261023('voc-radar-api'), // 1769
  // Scheduled workers (every 15 min; every run is a long call). 512 → 1024 at 3.00.00 (101.0 / 81.6 % p95);
  // 2026-10-18: heartbeat 1024 MB at 92.1 % → 1769 (one vCPU: projected 61.4 % at 1536), scanner 1024 MB at
  // 84.9 % → 1536 (projected 56.6 %). 2026-10-20 (DOUBLED_2026_10_20): heartbeat 1769 MB at 61.0 / 69.5 % → 3538,
  // scanner 1536 MB at 58.9 / 70.3 % → 3072.
  'voc-agent-heartbeat': cappedOn20261023('voc-agent-heartbeat'), // 1769
  'voc-memory-scanner': cappedOn20261023('voc-memory-scanner'), // 1769
  // 2026-10-18 (all at the old size): conductor 1024 MB at 83.0 % → 1536; briefing 1024 MB at 91.2 % and the
  // feedback processor 1024 MB at 90.9 % → 1769 (one vCPU: projected 60.8 % / 60.6 % at 1536); aggregation
  // processor 512 MB at 88.7 % → 1024. 2026-10-20: briefing 1769 MB at 63.8 / 72.6 % → 3538 (DOUBLED_2026_10_20).
  'voc-agent-conductor': 1536,
  // 2026-10-23: 1024 MB at 45.4 / 68.8 % (REMOVE batches of a bulk delete; 7 days to 2026-10-23) → 1536, after the
  // batch's REMOVE runs were coalesced (one write per distinct counter): about 1/7 of the CPU and duration per batch,
  // the share unchanged (fewer requests, same mix), so the one-step raise still applies.
  'voc-briefing': cappedOn20261023('voc-briefing'), // 1769
  'voc-feedback-processor': 1769,
  'voc-aggregation-processor': 1536,
  // ── over the new 60 % on 2026-10-18 ──
  // 1024 MB at 74 % (2026-10-06) → 1536; 2026-10-18: 1536 MB at 66.2 % → 1769 (one vCPU, the last rung that adds CPU).
  'voc-research-step': 1769,
  // 2026-10-18: 256 MB at 63.2 % CPU, peak memory 57.0 % → 512.
  'voc-users-api': 512,
  // ── fewer than 20 long calls on 2026-10-18 (insufficient data) but over 60 % ──
  // 256 → 512 (2.17.00: 87 %); 2026-10-18: 512 MB at 77.0 % → 1024.
  'voc-manual-import-api': 1024,
  // 256 → 512 (2.17.00: 85 %); 2026-10-18: 512 MB at 72.0 % → 1024.
  'voc-s3-import-api': 1024,
  // 512 → 1024 (79 % p95 ≥ 100 ms); 2026-10-18: 1024 MB at 78.2 % → 1536.
  'voc-scrapers-api': 1536,
  // 2026-10-18: 256 MB at 84.8 % → 512 (the only plugin webhook; api-stack.ts WEBHOOK_MEMORY_MB).
  'voc-webhook-github_issues': 512,
};

/** The owner's later move off a pin. The record stays as history; it waives nothing any more. */
interface PowerTuningSupersession {
  /** Decision date (ISO day). */
  readonly date: string;
  /** The size the function moved to (in RAISED_FOR_CPU). */
  readonly toMb: number;
  /** Why, in a few words. */
  readonly reason: string;
}

/** One AWS Lambda Power Tuning run behind a pinned size (docs/lambda-sizing.md). */
export interface PowerTuningRecord {
  /** Run date (ISO day). */
  readonly date: string;
  /** Strategy and setup of the run. */
  readonly method: string;
  /** Mean duration (ms) per tested size, as the run reported it. */
  readonly durationMs: Readonly<Record<number, number>>;
  /** The size the strategy picked. */
  readonly pickMb: number;
  /** The size pinned. While the pin stands the CPU rule does not judge it; peak memory does. */
  readonly pinnedMb: number;
  /** Set when the owner moved the function off the pin: the CPU rule judges every size again. */
  readonly superseded?: PowerTuningSupersession;
}

const PT_2026_10_06: Pick<PowerTuningRecord, 'date' | 'method'> = {
  date: '2026-10-06',
  method: 'balanced; production, read-only GET payloads as e2e-admin, 30 calls per size',
};

/** 2026-10-18: raise the six pinned APIs one step regardless of their curves (CPU over the 60 % ceiling). */
const raisedOn20261018 = (toMb: number): PowerTuningSupersession => ({
  date: '2026-10-18',
  toMb,
  reason: 'owner: raise regardless of the 2026-10-06 curve (CPU over the 60 % ceiling)',
});

/**
 * Sizes set from a Power Tuning curve. A standing pin overrides the CPU rule (the curve
 * measured duration vs memory directly; the share only estimates it), unless peak memory
 * breaks its ceiling. A superseded one is history only. lib/lambda-memory.test.ts keeps
 * each record in step with MEMORY_SIZES (the pin, or the size it was superseded by — doubled
 * where DOUBLED_2026_10_20 lists it: metrics and projects, 1536 → 3072 on 2026-10-20).
 */
export const POWER_TUNED: Readonly<Record<string, PowerTuningRecord>> = {
  // Pinned above the pick: 512 projected to 71.5 % CPU under the pre-2026-10-07 rule.
  'voc-ballots-api': { ...PT_2026_10_06, durationMs: { 512: 7.0, 1024: 5.8, 1536: 6.1, 1769: 6.0, 2048: 6.1 }, pickMb: 512, pinnedMb: 1024, superseded: raisedOn20261018(1769) },
  'voc-settings-api': { ...PT_2026_10_06, durationMs: { 512: 8.2, 1024: 7.6, 1536: 7.8, 1769: 8.4, 2048: 7.9 }, pickMb: 512, pinnedMb: 512, superseded: raisedOn20261018(1024) },
  'voc-metrics-api': { ...PT_2026_10_06, durationMs: { 512: 40.8, 1024: 21.9, 1536: 21.8, 1769: 20.7, 2048: 16.6 }, pickMb: 1024, pinnedMb: 1024, superseded: raisedOn20261018(1536) },
  'voc-projects-api': { ...PT_2026_10_06, durationMs: { 512: 54.0, 1024: 36.5, 1536: 35.1, 1769: 36.7, 2048: 34.1 }, pickMb: 1024, pinnedMb: 1024, superseded: raisedOn20261018(1536) },
  'voc-memory-api': { ...PT_2026_10_06, durationMs: { 512: 39.2, 1024: 23.3, 1536: 20.3, 1769: 23.6, 2048: 24.2 }, pickMb: 1024, pinnedMb: 1024, superseded: raisedOn20261018(1536) },
  'voc-agents-api': { ...PT_2026_10_06, durationMs: { 512: 10.9, 1024: 8.2, 1536: 8.3, 1769: 7.7, 2048: 7.9 }, pickMb: 1024, pinnedMb: 1024, superseded: raisedOn20261018(1769) },
};

/**
 * The standing Power Tuning record pinning `stem` at `memoryMb`, if there is one. A pin
 * covers only the size it pinned, and a superseded pin covers none. `records` defaults to
 * POWER_TUNED (tests pass their own).
 */
export function powerTuningPin(
  stem: string, memoryMb: number, records: Readonly<Record<string, PowerTuningRecord>> = POWER_TUNED,
): PowerTuningRecord | null {
  const record = Object.prototype.hasOwnProperty.call(records, stem) ? records[stem] : undefined;
  return record !== undefined && record.superseded === undefined && record.pinnedMb === memoryMb ? record : null;
}

/**
 * Raised one step because their PEAK memory broke the rule above, or came near it. The first
 * peak-rule run (production 2.14.00, 7 days to 2026-10-06, 45 functions) found none over its
 * ceiling — highest 58.6 % standard (integrations-api, 256 MB) and 58.2 % variable-payload
 * (manual-import-api, 256 MB, raised to 512 MB for CPU in 2.17.00 → 29 %).
 */
export const RAISED_FOR_PEAK_MEMORY: Readonly<Record<string, number>> = {
};

export const UNCHANGED: Readonly<Record<string, number | null>> = {
  // VocApiStack
  'voc-feedback-edit-api': 256,
  'voc-manual-import-processor': 1024,
  'voc-job-persona-generator': 1024,
  'voc-job-document-generator': 1024,
  'voc-job-document-merger': 1024,
  'voc-job-persona-importer': 512,
  'voc-chat-stream': 1024,
  // Assist twins (api-assist-workers.ts): the same code, role and env as their API Lambda, at their
  // own (4.00.00) size: the 2026-10-18 raise of voc-projects-api / voc-settings-api / voc-scrapers-api
  // was measured on the REST path and does not cover them (unmeasured).
  'voc-projects-assist': 1024,
  'voc-settings-assist': 512,
  'voc-scrapers-assist': 1024,
  // Engagement API (5.33.00): participants, asks and their self-invoked send slices, the board;
  // DynamoDB and SES at ≤ 10/s, I/O-bound (unmeasured, new).
  'voc-engagement-api': 512,
  // The SPA upload (api-stack.ts WEBSITE_DEPLOYMENT_MEMORY_MB): at the 128 MB default `aws s3 sync` ran out of
  // memory and timed out (5.36.01 deploy, 128 of 128 MB used).
  'VocApiStack/CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C1024MiBB049752D': 1024,
  // VocCoreStack
  'voc-cdn-signing-keys': 256,
  'voc-product-doc-extractor': 512,
  'voc-admin-bootstrap': null,
  'VocCoreStack/CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F': 128,
  'VocCoreStack/CdnSigningKeysProviderframeworkonEventF83ACC63': null,
  'VocCoreStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db8347ECC3691': null,
  'VocCoreStack/CustomMessageLambda448F9FBF': null,
  'VocCoreStack/AdminBootstrapProviderframeworkonEventF4719509': null,
  // The board pool (core-board-auth.ts; every deployment since 5.45.00, before only with `-c emailFrom`):
  // Cognito triggers, a few GetItems / one string render each (unmeasured, new in 5.33.00).
  'voc-board-pre-sign-up': 128,
  'voc-board-custom-message': 128,
  // The model agreements (BedrockModelAgreements under the id ImageModelAccess, bedrock-access-stack.ts):
  // deploy-time custom resource for the image model (5.45.00) and every Claude model, the CDK default.
  'VocCoreStack/ImageModelAccessModelAgreementLambda252AEB5F': null,
  'VocCoreStack/ImageModelAccessModelAgreementProviderframeworkonEvent9F14CFC9': null,
  // VocIngestionStack (plugins enabled in cdk.context.json)
  'voc-ingestor-app_reviews_android': 1024,
  'voc-ingestor-app_reviews_ios': 1024,
  'voc-ingestor-github_issues': 512, // manifest infrastructure.ingestor.memory (2.16.00)
  'voc-ingestor-s3_import': 512,
  'voc-ingestor-synthetic_reviews': 512,
  'voc-ingestor-web_reviews': 512, // manifest; the browser runs in AgentCore, the Lambda only drives it (3.18.00)
  'voc-ingestor-webscraper': 512,
  // Live-website design capture (wave 12): like web_reviews the browser runs in AgentCore; the Lambda drives
  // one page, decodes one JPEG (<= 3.75 MB) and makes one model call (unmeasured, new).
  'voc-design-capture': 512,
  'VocIngestionStack/CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F': 128,
  'VocIngestionStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db8347ECC3691': null,
  // VocProcessingStack
  'voc-category-reprocess': 1024,
  'voc-memory-extractor': 1024,
  'voc-memory-retention': 512,
  // Per-source retention / erasure: I/O-bound paged deletes, no model calls (unmeasured, new in KVD).
  'voc-retention': 512,
  'voc-agent-nodes': 1024,
  'voc-agent-persona-panel': 1024,
  // Plan mode: one step of an approved assistant plan (Node, built from lambda/stream; the same
  // size as voc-chat-stream, whose tool loop a think step runs; unmeasured, new in KVP).
  'voc-plan-step': 1024,
  // Radar release scan: web search + a few model calls per brand, I/O-bound; unmeasured, new in 5.04.00.
  'voc-radar-scan': 512,
  // VocWebSearchStack
  'VocWebSearchStack/AWS679f53fac002430cb0da5b7982bd22872D164C4C': 512,
};

/** What the default synth must emit, per function. */
export const MEMORY_SIZES: Readonly<Record<string, number | null>> = {
  ...UNCHANGED,
  ...RAISED_FOR_CPU,
  ...RAISED_FOR_PEAK_MEMORY,
};

/**
 * Functions only a non-default context flag synthesizes, with their size. Never in
 * MEMORY_SIZES (the default synth must match that exactly); each is pinned by its own
 * stack test instead (lib/stacks/email-intake.test.ts).
 */
export const OPTIONAL_FUNCTION_SIZES: Readonly<Record<string, number>> = {
  // `-c inboundEmailDomain` (docs/email-intake.md). 2026-10-18: 512 MB at 87.0 % CPU → 1024.
  'voc-email-intake': 1024,
};

/** The size this checkout deploys, per function, under any context (capacity-report `--repo-sizes`). */
export const REPO_SIZES: Readonly<Record<string, number | null>> = {
  ...MEMORY_SIZES,
  ...OPTIONAL_FUNCTION_SIZES,
};
