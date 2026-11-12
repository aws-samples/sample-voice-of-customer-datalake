/**
 * THE fixed-cost gate (TENETS.md, tenet 7: fully serverless, no fixed monthly cost by default).
 *
 * Synthesizes the WHOLE app (bin/voc-datalake.ts, every stack) in the default shape and in the
 * all-features shape (test-support/all-features-context.ts: every context-gated feature on, data
 * protection included) and fails on any resource or setting that bills whether or not the platform is
 * used: WAF, SnapStart, provisioned concurrency, NAT gateways, Elastic IPs, interface VPC endpoints, EC2
 * instances, ECS services, RDS, ElastiCache, DAX, OpenSearch, MSK, Redshift, DocumentDB, Neptune, Global
 * Accelerator, PROVISIONED DynamoDB or Kinesis capacity, an API Gateway cache cluster, a CloudFront
 * dedicated IP, a hosted zone the app creates (rules: test-support/fixed-cost-rules.ts).
 * Each finding names the resource and says "fixed monthly cost: off by default (TENETS.md, tenet 7);
 * make it opt-in behind a context flag".
 *
 * ALLOWED: Lambda RESERVED concurrency (`ReservedConcurrentExecutions`) costs nothing (it caps a
 * function's share of the account pool); the MCP endpoint keeps its 20 (`-c mcpReservedConcurrency`).
 * Record sets in an EXISTING hosted zone (the inbound-email intake imports its zone by id) are fine.
 *
 * OPT_IN_FIXED_COSTS (test-support/fixed-cost-rules.ts) names the opt-in flags that legitimately add a fixed cost when turned on, and
 * exactly what they add. Each is synthesized with its flag and must produce those findings and no
 * others, which also proves the gate fires on a real template.
 *
 * COUNTED_FIXED_COSTS (same file) holds the default synth to its per-resource monthly costs: exactly one
 * customer-managed KMS key (the accepted baseline) and the known Secrets Manager baseline, which may only shrink.
 *
 * RUNTIME_FIXED_COSTS (same file) names the counted resources the app creates at RUN time, which no template holds:
 * the only grant of `kms:CreateKey` or `secretsmanager:CreateSecret` in the app is the workspaces API's on
 * `voc/ws/*`, one credentials secret per workspace (docs/multi-workspace.md, decision 8: about $0.40 a month each).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import {
  countedFixedCostFindings, FIXED_COST_REMEDY, fixedCostFindings, OPT_IN_FIXED_COSTS, RUNTIME_FIXED_COSTS,
  runtimeFixedCostFindings, type FixedCostFinding,
} from './test-support/fixed-cost-rules';
import { cleanupAssemblyDirs, synthApp, type SynthResult } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

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

  it('holds exactly one KMS key and no more secrets than the baseline (COUNTED_FIXED_COSTS): reuse the Core key, lower a baseline that shrank', () => {
    const templates = result.stackNames.map((stack) => ({ stack, template: result.template(stack) }));
    expect(countedFixedCostFindings(templates)).toStrictEqual([]);
  });

  it('creates a key or secret at run time only as RUNTIME_FIXED_COSTS names it: the per-workspace secrets', () => {
    const templates = result.stackNames.map((stack) => ({ stack, template: result.template(stack) }));
    expect(runtimeFixedCostFindings(templates)).toStrictEqual([]);
  });
});

describe('RUNTIME_FIXED_COSTS', () => {
  it('is exactly the workspaces API\'s CreateSecret on voc/ws/* (decision 8, one secret per workspace)', () => {
    expect(RUNTIME_FIXED_COSTS.map(({ action, role, resourceSuffix }) => [action, role, resourceSuffix]))
      .toStrictEqual([['secretsmanager:CreateSecret', 'WorkspacesLambdaRole', ':secret:voc/ws/*']]);
  });

  it('finds an unlisted runtime create, and an entry whose grant is gone', () => {
    const policy = (id: string, Action: string, Resource: unknown) => ({ [id]: { Type: 'AWS::IAM::Policy', Properties: {
      PolicyDocument: { Statement: [{ Effect: 'Allow', Action, Resource }] } } } });
    const other = [{ stack: 'S', template: { Resources: policy('OtherRoleDefaultPolicyAAAA', 'secretsmanager:*', '*') } }];
    expect(runtimeFixedCostFindings(other)).toStrictEqual([
      expect.stringMatching(/^S\/OtherRoleDefaultPolicyAAAA may secretsmanager:CreateSecret on "\*"/),
      expect.stringMatching(/^RUNTIME_FIXED_COSTS lists one credentials secret per workspace/),
    ]);
    const wider = [{ stack: 'S', template: { Resources: policy('WorkspacesLambdaRoleDefaultPolicyAAAA',
      'secretsmanager:CreateSecret', 'arn:aws:secretsmanager:us-east-1:1:secret:*') } }];
    expect(runtimeFixedCostFindings(wider)).toHaveLength(2);
  });

  it('accepts the same grant in a -c deploymentPrefix deployment, and nothing else under that prefix', () => {
    const policy = (Resource: string) => [{ stack: 'S', template: { Resources: { WorkspacesLambdaRoleDefaultPolicyAAAA: {
      Type: 'AWS::IAM::Policy', Properties: { PolicyDocument: { Statement: [
        { Effect: 'Allow', Action: 'secretsmanager:CreateSecret', Resource }] } } } } } }];
    expect(runtimeFixedCostFindings(policy('arn:aws:secretsmanager:us-east-1:1:secret:b-voc/ws/*'))).toStrictEqual([]);
    expect(runtimeFixedCostFindings(policy('arn:aws:secretsmanager:us-east-1:1:secret:b-other/*'))).toHaveLength(2);
  });
});

describe.each(OPT_IN_SHAPES)('opt-in -c %s=true', (_flag, result, expected) => {
  it('adds exactly the fixed costs it is allowed to, and the gate names each one', () => {
    const findings = findingsOf(result);
    const keys = findings.map((finding) => `${finding.type} ${finding.logicalId}`).sort(byCodeUnit);
    // One-to-one: every finding matches exactly one expected pattern, and every pattern exactly one finding.
    expect(keys.filter((key) => expected.filter((pattern) => pattern.test(key)).length !== 1)).toStrictEqual([]);
    expect(expected.filter((pattern) => keys.filter((key) => pattern.test(key)).length !== 1)).toStrictEqual([]);
    expect(findings.filter((finding) => !finding.message.endsWith(FIXED_COST_REMEDY))).toStrictEqual([]);
  });
});
