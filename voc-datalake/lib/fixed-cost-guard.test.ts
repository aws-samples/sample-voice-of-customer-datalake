/**
 * THE fixed-cost gate (TENETS.md, tenet 7: fully serverless, no fixed monthly cost by default).
 *
 * Synthesizes the WHOLE app (bin/voc-datalake.ts, every stack) in the default shape and in the
 * all-features shape (test-support/all-features-context.ts: every context-gated feature on, data
 * protection included) and fails on any resource or setting that bills whether or not the platform is
 * used: WAF, SnapStart, provisioned concurrency, NAT gateways, EC2 instances, ECS services, RDS,
 * ElastiCache, OpenSearch, PROVISIONED DynamoDB or Kinesis capacity, an API Gateway cache cluster, a
 * CloudFront dedicated IP, a hosted zone the app creates (rules: test-support/fixed-cost-rules.ts).
 * Each finding names the resource and says "fixed monthly cost: off by default (TENETS.md, tenet 7);
 * make it opt-in behind a context flag".
 *
 * ALLOWED: Lambda RESERVED concurrency (`ReservedConcurrentExecutions`) costs nothing (it caps a
 * function's share of the account pool); the MCP endpoint keeps its 20 (`-c mcpReservedConcurrency`).
 * Record sets in an EXISTING hosted zone (the inbound-email intake imports its zone by id) are fine.
 *
 * OPT_IN_FIXED_COSTS names the opt-in flags that legitimately add a fixed cost when turned on, and
 * exactly what they add. Each is synthesized with its flag and must produce those findings and no
 * others, which also proves the gate fires on a real template.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import { FIXED_COST_REMEDY, fixedCostFindings, type FixedCostFinding } from './test-support/fixed-cost-rules';
import { cleanupAssemblyDirs, synthApp, type SynthResult } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';
import { SNAPSTART_CONTEXT_KEY, SNAPSTART_FUNCTION_IDS } from './utils/snapstart';

/** An opt-in flag allowed to add a fixed cost: its context, and the `<type> <logical id pattern>` findings it adds. */
interface OptInFixedCost {
  readonly context: Readonly<Record<string, unknown>>;
  readonly expected: readonly RegExp[];
}

const OPT_IN_FIXED_COSTS: Readonly<Record<string, OptInFixedCost>> = {
  // `-c snapStart=true` (lib/utils/snapstart.ts): the four cold-start-bound API Lambdas.
  snapStart: {
    context: { [SNAPSTART_CONTEXT_KEY]: 'true' },
    expected: SNAPSTART_FUNCTION_IDS.map((id) => new RegExp(`^AWS::Lambda::Function (GlobalMcp)?${id}[0-9A-F]{8}$`)),
  },
};

// Module-level synths like lib/app-template-gates.test.ts (~8-10 s each, out of process).
const SHAPES: readonly (readonly [string, SynthResult])[] = [
  ['default', synthApp()],
  ['allFeatures', synthApp({ ...ALL_FEATURES_CONTEXT })],
];
const OPT_IN_SHAPES: readonly (readonly [string, SynthResult, readonly RegExp[]])[] = Object.entries(OPT_IN_FIXED_COSTS)
  .map(([flag, { context, expected }]) => [flag, synthApp({ ...context }), expected] as const);
afterAll(cleanupAssemblyDirs);

function findingsOf(result: SynthResult): FixedCostFinding[] {
  return result.stackNames.flatMap((stack) => fixedCostFindings(stack, result.template(stack)));
}

describe.each(SHAPES)('the %s synth', (_shape, result) => {
  it('has no fixed-cost resource or setting', () => {
    expect(result.stackNames.length, 'expected the whole app').toBeGreaterThanOrEqual(4);
    expect(findingsOf(result).map((finding) => finding.message)).toStrictEqual([]);
  });
});

describe.each(OPT_IN_SHAPES)('opt-in -c %s=true', (_flag, result, expected) => {
  it('adds exactly the fixed costs it is allowed to, and the gate names each one', () => {
    const findings = findingsOf(result);
    const keys = findings.map((finding) => `${finding.type} ${finding.logicalId}`).sort(byCodeUnit);
    expect(keys).toHaveLength(expected.length);
    expect(expected.filter((pattern) => !keys.some((key) => pattern.test(key)))).toStrictEqual([]);
    expect(findings.filter((finding) => !finding.message.endsWith(FIXED_COST_REMEDY))).toStrictEqual([]);
  });
});
