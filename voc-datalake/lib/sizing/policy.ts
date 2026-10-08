/**
 * The Lambda sizing policy, in ONE place (docs/lambda-sizing.md).
 *
 * Read by:
 * - lib/lambda-memory.test.ts — pins every synthesized function's MemorySize to
 *   `MEMORY_SIZES` below, and checks the classification covers exactly those;
 * - lib/sizing/capacity.ts — evaluates production measurements against the rule
 *   (scripts/capacity/capacity-query.sh, frontend/e2e/tests/ops-capacity.spec.ts).
 *
 * THE RULE (owner-approved 2026-10-05, CPU half refined 2026-10-07). AWS publishes no
 * utilisation target; 70 % is our trigger for an investigation, not a final size
 * (Power Tuning decides that):
 * - Memory: PEAK (`max_memory_used` over the window, not p95) ≤ 70 % of MemorySize,
 *   and ≤ 60 % for a variable-payload function — one whose memory grows with what a
 *   caller sends or a batch holds, so the headroom has to absorb the next, larger one.
 * - CPU: over the invocations that ran ≥ 100 ms only, the worse of (a) the wall-weighted
 *   share and (b) the p95 share, ≤ 70 %. A share is CPU time / (wall time × MemorySize /
 *   1,769 MB), from the `invocation_cost` line every function logs
 *   (lambda/shared/invocation_cost.py, lambda/stream/src/lib/invocation-cost.ts).
 *   Short calls are excluded from BOTH figures: an 8–50 ms warm read is CPU-busy for
 *   its whole wall time at any size, so its share says nothing about whether more
 *   memory would help (Power Tuning 2026-10-06: 87–95 % weighted at 1,024 MB on six
 *   functions whose duration did not improve with more memory).
 * - Fewer than CPU_MIN_LONG_CALLS such calls in the window: CPU is "insufficient
 *   data" — listed, not a breach.
 * - A size pinned by Power Tuning (POWER_TUNED) overrides the CPU rule; only its peak
 *   memory is judged. The curve measured what the share only estimates.
 *
 * Keep this file dependency-free: the e2e package imports it too (no zod there).
 */

/** Lambda allocates one full vCPU at 1,769 MB; single-threaded Python gains nothing above it. */
export const MB_PER_VCPU = 1769;

/** CPU ceiling, % of the function's share (both the weighted and the p95 figure, over long calls). */
export const CPU_MAX_PCT = 70;

/** Only invocations at least this long count towards either CPU figure. */
export const CPU_LONG_CALL_MS = 100;

/** Fewer long calls than this in the window: CPU is "insufficient data", not judged. */
export const CPU_MIN_LONG_CALLS = 20;

export type SizingClass = 'standard' | 'variable-payload';

/** Peak-memory ceiling by class, % of MemorySize. */
export const MEMORY_PEAK_MAX_PCT: Readonly<Record<SizingClass, number>> = {
  standard: 70,
  'variable-payload': 60,
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
 * Variable-payload functions (the 60 % class), with why. Physical-name stems
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
  'voc-mcp-token-authorizer': 'inline Node authorizer (Code.fromInline): a string-shape check per request',
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

/**
 * Raised for CPU per the capacity evidence (2.17.00, and the 3.00.00 production check:
 * voc-e2e/verify/3.00.00/CAPACITY-REPORT.md): sized so the share is ≤ 70 %
 * (old share × old MB / new MB). Upsize-only for now (owner decision 2026-10-07):
 * nothing here is lowered towards a smaller Power Tuning pick yet.
 *
 * The six marked [PT] were then sized by AWS Lambda Power Tuning in production; the
 * runs are recorded in POWER_TUNED below, whose pins waive the CPU rule.
 */
export const RAISED_FOR_CPU: Readonly<Record<string, number>> = {
  'voc-ballots-api': 1024, //        256 MB at 143% → 512 would be 71.5%, so two steps.
  //                                 [PT] picked 512 (7.0 ms vs 5.8 ms at 1024); kept at 1024: 512 breaks the 70 % CPU rule
  'voc-settings-api': 512, //        256 MB at 129%. [PT] picked 512
  'voc-agents-api': 1024, //         512 MB at 102%. [PT] picked 1024
  'voc-chat-api': 1024, //           512 MB at 94%
  'voc-metrics-api': 1024, //        512 MB at 88%. [PT] picked 1024 (40.8 ms → 21.9 ms; flat above)
  'voc-projects-api': 1024, //       512 MB at 76%. [PT] picked 1024 (54.0 ms → 36.5 ms; flat above)
  'voc-data-explorer-api': 512, //   256 MB at 92%
  // 256 MB at 87% → 512 (2.17.00); 512 MB at 86.0 % weighted / 105.1 % p95 over 11 long calls since the
  // 3.00.00 deploy (insufficient data, but 256 MB was 88.3 / 109.6 % over 21) → one step to 1024.
  // The share barely moved 256 → 512, so 1024 may not clear 70 % either: Power Tune it next.
  // Evidence: voc-e2e/verify/3.00.00/CAPACITY-REPORT.md.
  'voc-logs-api': 1024,
  'voc-manual-import-api': 512, //   256 MB at 87%
  // 256 MB at 86% → 512 (2.17.00); 512 MB at 71.4 % weighted / 88.5 % p95 over 29 long calls since the
  // 3.00.00 deploy, warm calls breaching too (103.4 % p95) → one step to 1024. Evidence:
  // voc-e2e/verify/3.00.00/CAPACITY-REPORT.md ("SnapStart APIs", breach 1).
  'voc-integrations-api': 1024,
  'voc-s3-import-api': 512, //       256 MB at 85%
  // 256 MB at 84% → 512 (2.17.00); 512 MB at 79.9 % p95 over 60 long calls since the 3.00.00 deploy,
  // mostly the first call after a SnapStart restore (93.0 % p95) → one step to 1024. Evidence:
  // voc-e2e/verify/3.00.00/CAPACITY-REPORT.md ("SnapStart APIs", breach 2).
  'voc-feedback-form-api': 1024,
  // 256 MB at 84% → 512 (2.17.00); 512 MB at 67.4 % weighted / 98.0 % p95 over 11 long calls since the
  // 3.00.00 deploy, mostly first calls after a SnapStart restore → one step to 1024 (≈ 49 % p95).
  'voc-mcp-tokens-api': 1024,
  'voc-memory-api': 1024, //         512 MB at 85% (p95 of invocations >= 100 ms). [PT] picked 1024
  'voc-scrapers-api': 1024, //       512 MB at 79% (p95 of invocations >= 100 ms)
  // 1024 MB at 74% (p95 of invocations >= 100 ms, 7 days to 2026-10-06) → 1536 MB ≈ 49%
  'voc-research-step': 1536,
  // Scheduled workers (VocProcessingStack, every 15 min). Every run is a long call, so the 20-call
  // threshold is reached within hours; at 3.00.00 (13 calls) both were over → one step each.
  'voc-agent-heartbeat': 1024, //    512 MB at 85.7 % weighted / 101.0 % p95 (13 long calls) → ≈ 50 % p95
  'voc-memory-scanner': 1024, //     512 MB at 77.0 % weighted / 81.6 % p95 (13 long calls) → ≈ 41 % p95
};

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
  /** The size pinned (in RAISED_FOR_CPU). The CPU rule does not judge it; peak memory does. */
  readonly pinnedMb: number;
}

const PT_2026_10_06: Pick<PowerTuningRecord, 'date' | 'method'> = {
  date: '2026-10-06',
  method: 'balanced; production, read-only GET payloads as e2e-admin, 30 calls per size',
};

/**
 * Sizes set from a Power Tuning curve. A pin overrides the CPU rule (the curve measured
 * duration vs memory directly; the share only estimates it), unless peak memory breaks
 * its ceiling. lib/lambda-memory.test.ts keeps each pin in step with MEMORY_SIZES.
 */
export const POWER_TUNED: Readonly<Record<string, PowerTuningRecord>> = {
  // Pinned above the pick: 512 projected to 71.5 % CPU under the pre-2026-10-07 rule. Under
  // the refined rule the pick would stand (ballots' calls are ~6 ms); lowering it is an
  // owner decision, not taken here.
  'voc-ballots-api': { ...PT_2026_10_06, durationMs: { 512: 7.0, 1024: 5.8, 1536: 6.1, 1769: 6.0, 2048: 6.1 }, pickMb: 512, pinnedMb: 1024 },
  'voc-settings-api': { ...PT_2026_10_06, durationMs: { 512: 8.2, 1024: 7.6, 1536: 7.8, 1769: 8.4, 2048: 7.9 }, pickMb: 512, pinnedMb: 512 },
  'voc-metrics-api': { ...PT_2026_10_06, durationMs: { 512: 40.8, 1024: 21.9, 1536: 21.8, 1769: 20.7, 2048: 16.6 }, pickMb: 1024, pinnedMb: 1024 },
  'voc-projects-api': { ...PT_2026_10_06, durationMs: { 512: 54.0, 1024: 36.5, 1536: 35.1, 1769: 36.7, 2048: 34.1 }, pickMb: 1024, pinnedMb: 1024 },
  'voc-memory-api': { ...PT_2026_10_06, durationMs: { 512: 39.2, 1024: 23.3, 1536: 20.3, 1769: 23.6, 2048: 24.2 }, pickMb: 1024, pinnedMb: 1024 },
  'voc-agents-api': { ...PT_2026_10_06, durationMs: { 512: 10.9, 1024: 8.2, 1536: 8.3, 1769: 7.7, 2048: 7.9 }, pickMb: 1024, pinnedMb: 1024 },
};

/** The Power Tuning record pinning `stem` at `memoryMb`, if there is one. */
export function powerTuningPin(stem: string, memoryMb: number): PowerTuningRecord | null {
  const record = Object.prototype.hasOwnProperty.call(POWER_TUNED, stem) ? POWER_TUNED[stem] : undefined;
  return record?.pinnedMb === memoryMb ? record : null;
}

/**
 * Raised one step because their PEAK memory broke the rule above. Empty on purpose:
 * the first peak-rule run (production 2.14.00, 7 days to 2026-10-06, 45 functions)
 * found no function over its ceiling at the deployed sizes or at the 2.17.00 sizes —
 * highest 58.6 % standard (integrations-api, 256 MB) and 58.2 % variable-payload
 * (manual-import-api, 256 MB, raised to 512 MB for CPU in 2.17.00 → 29 %).
 */
export const RAISED_FOR_PEAK_MEMORY: Readonly<Record<string, number>> = {};

export const UNCHANGED: Readonly<Record<string, number | null>> = {
  // VocApiStack
  'voc-feedback-edit-api': 256,
  'voc-manual-import-processor': 1024,
  'voc-users-api': 256,
  'voc-job-persona-generator': 1024,
  'voc-job-document-generator': 1024,
  'voc-job-document-merger': 1024,
  'voc-job-persona-importer': 512,
  'voc-chat-stream': 1024,
  'voc-mcp-token-authorizer': 128,
  'voc-mcp-global-api': 256,
  // Plugin webhook receivers (api-stack.ts: one per enabled plugin with a webhook)
  'voc-webhook-github_issues': 256,
  'VocApiStack/CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C81C01536': null,
  // VocCoreStack
  'voc-cdn-signing-keys': 256,
  'voc-product-doc-extractor': 512,
  'voc-admin-bootstrap': null,
  'VocCoreStack/CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F': 128,
  'VocCoreStack/CdnSigningKeysProviderframeworkonEventF83ACC63': null,
  'VocCoreStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db8347ECC3691': null,
  'VocCoreStack/CustomMessageLambda448F9FBF': null,
  'VocCoreStack/AdminBootstrapProviderframeworkonEventF4719509': null,
  // VocIngestionStack (plugins enabled in cdk.context.json)
  'voc-ingestor-app_reviews_android': 1024,
  'voc-ingestor-app_reviews_ios': 1024,
  'voc-ingestor-github_issues': 512, // manifest infrastructure.ingestor.memory (2.16.00)
  'voc-ingestor-s3_import': 512,
  'voc-ingestor-synthetic_reviews': 512,
  'voc-ingestor-webscraper': 512,
  'VocIngestionStack/CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F': 128,
  'VocIngestionStack/BucketNotificationsHandler050a0587b7544547bf325f094a3db8347ECC3691': null,
  // VocProcessingStack
  'voc-feedback-processor': 1024,
  'voc-aggregation-processor': 512,
  'voc-category-reprocess': 1024,
  'voc-memory-extractor': 1024,
  'voc-memory-retention': 512,
  // Per-source retention / erasure: I/O-bound paged deletes, no model calls (unmeasured, new in KVD).
  'voc-retention': 512,
  'voc-agent-conductor': 1024,
  'voc-agent-nodes': 1024,
  'voc-agent-persona-panel': 1024,
  // VocWebSearchStack
  'VocWebSearchStack/BedrockModelAccessModelAgreementLambda6BECE77F': null,
  'VocWebSearchStack/BedrockModelAccessModelAgreementProviderframeworkonEventBFFB8E4D': null,
  'VocWebSearchStack/AWS679f53fac002430cb0da5b7982bd22872D164C4C': 512,
};

/** What the default synth must emit, per function. */
export const MEMORY_SIZES: Readonly<Record<string, number | null>> = {
  ...UNCHANGED,
  ...RAISED_FOR_CPU,
  ...RAISED_FOR_PEAK_MEMORY,
};
