/**
 * Template gates over the WHOLE app (bin/voc-datalake.ts, every stack), in both synth shapes: the default
 * deploy and every context-gated feature on (test-support/all-features-context.ts). Neither shape is a
 * superset of the other, so both are read.
 *
 * 1. No unreviewed `Resource: "*"`. Every identity-policy `Allow` on `"*"` (AWS::IAM::Policy,
 *    AWS::IAM::ManagedPolicy, inline AWS::IAM::Role policies) uses only actions on the reviewed list
 *    lib/utils/resource-star-actions.ts, testing the condition keys an entry requires; no `Allow` uses
 *    `NotAction` / `NotResource`; and every list entry is still used, so a stale entry cannot sit there as
 *    pre-approval for the next grant. Resource-based policies (KMS key policies, where `"*"` means "this
 *    key") are out of scope.
 * 2. SQS visibility. For every Lambda event source mapping whose source is an SQS queue, the queue's
 *    visibility timeout is at least 6 x the function timeout + the batching window (AWS Lambda,
 *    https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html). Cross-stack sources
 *    (`Fn::ImportValue`) are followed to the exporting stack.
 * 3. The all-features synth has no cdk-nag error or CDK warning (the default synth is held to that by
 *    lib/app-baseline.test.ts), which is what proves the per-policy `Resource::*` suppression
 *    (lib/utils/nag-resource-star.ts) still covers every reviewed grant once the stack-wide one is gone.
 * 4. Every `bedrock:InvokeModel*` statement on a Claude model names the e2e profile's Haiku 5.5 and its
 *    capacity fallback, as `global.` inference profile and foundation model (test-support/bedrock-grants.ts;
 *    the `eu.` synth: lib/app-inference-scope.test.ts).
 *
 * What it cannot prove: that a reviewed reason is still true, or that a non-`"*"` resource is narrow
 * enough (`arn:...:*` patterns are the per-role suites' and cdk-nag's job).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import { claudeInvokeStatements, e2eProfileModels, missingModelGrants } from './test-support/bedrock-grants';
import { cleanupAssemblyDirs, diagnostics, synthApp, type SynthResult } from './test-support/synth-app';
import { TemplateResourcesSchema } from './test-support/template-resources';
import { byCodeUnit } from './utils/compare';
import { RESOURCE_STAR_ACTIONS, isReviewedResourceStarAction } from './utils/resource-star-actions';

// Two synths for the whole file, at module level like lib/app-baseline.test.ts (~8-10 s each, out of process).
const SHAPES: { readonly default: SynthResult; readonly allFeatures: SynthResult } = {
  default: synthApp(),
  allFeatures: synthApp({ ...ALL_FEATURES_CONTEXT }),
};
afterAll(cleanupAssemblyDirs);

const OutputsSchema = z.record(z.string(), z.object({ Value: z.unknown(), Export: z.object({ Name: z.unknown() }).optional() }));

interface StackTemplate {
  readonly stack: string;
  readonly resources: z.infer<typeof TemplateResourcesSchema>;
  readonly outputs: z.infer<typeof OutputsSchema>;
}

function stacksOf(result: SynthResult): StackTemplate[] {
  return result.stackNames.map((stack) => {
    const template = result.template(stack);
    return {
      stack,
      resources: TemplateResourcesSchema.parse(template.Resources ?? {}),
      outputs: OutputsSchema.parse(template.Outputs ?? {}),
    };
  });
}

// ── 1. Resource "*" ──────────────────────────────────────────────────

const StatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]).optional(),
  NotAction: z.unknown().optional(),
  Resource: z.unknown().optional(),
  NotResource: z.unknown().optional(),
  Condition: z.unknown().optional(),
});
type Statement = z.infer<typeof StatementSchema>;
const DocumentSchema = z.object({ Statement: z.array(StatementSchema) });
const InlinePoliciesSchema = z.array(z.object({ PolicyDocument: DocumentSchema })).optional();

interface LocatedStatement { readonly where: string; readonly statement: Statement }

/** Every identity-policy statement of the stack, located as `<stack>/<logical id>`. */
function identityStatements({ stack, resources }: StackTemplate): LocatedStatement[] {
  return Object.entries(resources).flatMap(([logicalId, { Type, Properties }]) => {
    let documents: z.infer<typeof DocumentSchema>[] = [];
    if (Type === 'AWS::IAM::Policy' || Type === 'AWS::IAM::ManagedPolicy') {
      documents = [DocumentSchema.parse(Properties.PolicyDocument)];
    } else if (Type === 'AWS::IAM::Role') {
      documents = (InlinePoliciesSchema.parse(Properties.Policies) ?? []).map((p) => p.PolicyDocument);
    }
    return documents.flatMap((d) => d.Statement.map((statement) => ({ where: `${stack}/${logicalId}`, statement })));
  });
}

const isAllow = (s: Statement) => (s.Effect ?? 'Allow') === 'Allow';
const isStar = (r: unknown) => r === '*' || (Array.isArray(r) && r.includes('*'));
const actionsOf = (s: Statement) => (typeof s.Action === 'string' ? [s.Action] : s.Action ?? []);

const allStatements = Object.entries(SHAPES).flatMap(([shape, result]) =>
  stacksOf(result).flatMap(identityStatements).map((located) => ({ ...located, where: `${shape}: ${located.where}` })));
const starStatements = allStatements.filter(({ statement }) => isAllow(statement) && isStar(statement.Resource));

describe('Resource "*" in identity policies', () => {
  it('reads real statements (vacuity guard)', () => {
    expect(allStatements.length).toBeGreaterThan(500);
    expect(starStatements.length).toBeGreaterThan(20);
  });

  it('grants only reviewed actions on "*" (lib/utils/resource-star-actions.ts), conditioned where required', () => {
    const unreviewed = starStatements.flatMap(({ where, statement }) => actionsOf(statement)
      .filter((action) => !isReviewedResourceStarAction(action, statement.Condition))
      .map((action) => `${where}: ${action}${statement.Condition === undefined ? '' : ' (conditioned)'}`));
    unreviewed.sort(byCodeUnit);
    expect(unreviewed).toStrictEqual([]);
  });

  it('never allows with NotAction or NotResource', () => {
    const inverted = allStatements
      .filter(({ statement }) => isAllow(statement) && (statement.NotAction !== undefined || statement.NotResource !== undefined))
      .map(({ where }) => where);
    expect(inverted).toStrictEqual([]);
  });

  it('has no stale reviewed entry: every action on the list is granted on "*" in some shape', () => {
    const used = new Set(starStatements.flatMap(({ statement }) => actionsOf(statement)));
    expect(Object.keys(RESOURCE_STAR_ACTIONS).filter((action) => !used.has(action)).sort(byCodeUnit)).toStrictEqual([]);
  });
});

// ── 2. SQS visibility ≥ 6 × function timeout + batching window ───────

/** CloudFormation defaults when the property is absent. */
const DEFAULT_FUNCTION_TIMEOUT_SECONDS = 3;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;

interface Located { readonly stack: StackTemplate; readonly logicalId: string }

const GetAttSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) });
const RefSchema = z.object({ Ref: z.string() });
const ImportSchema = z.object({ 'Fn::ImportValue': z.string() });
const SecondsSchema = z.number().optional();

/** The resource `value` points at (`Ref`, `Fn::GetAtt`, or an export of another stack), or undefined. */
function resolve(stacks: StackTemplate[], stack: StackTemplate, value: unknown): Located | undefined {
  const local = RefSchema.safeParse(value).data?.Ref ?? GetAttSchema.safeParse(value).data?.['Fn::GetAtt'][0];
  if (local !== undefined) return stack.resources[local] ? { stack, logicalId: local } : undefined;
  const exportName = ImportSchema.safeParse(value).data?.['Fn::ImportValue'];
  if (exportName === undefined) return undefined;
  for (const other of stacks) {
    const output = Object.values(other.outputs).find((o) => o.Export?.Name === exportName);
    if (output) return resolve(stacks, other, output.Value);
  }
  return undefined;
}

const resourceAt = (l: Located) => l.stack.resources[l.logicalId];

/** The function's timeout in seconds (following one alias hop), or undefined when it cannot be read. */
function functionTimeout(stacks: StackTemplate[], target: Located | undefined): number | undefined {
  const resource = target && resourceAt(target);
  if (!target || !resource) return undefined;
  if (resource.Type === 'AWS::Lambda::Alias') {
    return functionTimeout(stacks, resolve(stacks, target.stack, resource.Properties.FunctionName));
  }
  if (resource.Type !== 'AWS::Lambda::Function') return undefined;
  return SecondsSchema.parse(resource.Properties.Timeout) ?? DEFAULT_FUNCTION_TIMEOUT_SECONDS;
}

interface SqsMapping { readonly where: string; readonly visibility: number; readonly timeout: number; readonly window: number }

/** Every SQS event source mapping of the shape, or a problem string for one that cannot be resolved. */
function sqsMappings(stacks: StackTemplate[]): (SqsMapping | string)[] {
  return stacks.flatMap((stack) => Object.entries(stack.resources)
    .filter(([, r]) => r.Type === 'AWS::Lambda::EventSourceMapping')
    .flatMap(([logicalId, { Properties }]): (SqsMapping | string)[] => {
      const where = `${stack.stack}/${logicalId}`;
      const source = resolve(stacks, stack, Properties.EventSourceArn);
      const sourceResource = source && resourceAt(source);
      if (!sourceResource) return [`${where}: event source not resolvable`];
      if (sourceResource.Type !== 'AWS::SQS::Queue') return [];
      const timeout = functionTimeout(stacks, resolve(stacks, stack, Properties.FunctionName));
      if (timeout === undefined) return [`${where}: function not resolvable`];
      return [{
        where,
        visibility: SecondsSchema.parse(sourceResource.Properties.VisibilityTimeout) ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
        timeout,
        window: SecondsSchema.parse(Properties.MaximumBatchingWindowInSeconds) ?? 0,
      }];
    }));
}

describe('SQS event sources', () => {
  const byShape = Object.entries(SHAPES).map(([shape, result]) => [shape, sqsMappings(stacksOf(result))] as const);

  it.each(byShape)('%s: every mapping resolves to its queue and function', (_shape, mappings) => {
    expect(mappings.filter((m) => typeof m === 'string')).toStrictEqual([]);
  });

  it.each(byShape)('%s: visibility timeout >= 6 x function timeout + batching window', (_shape, mappings) => {
    const resolved = mappings.filter((m): m is SqsMapping => typeof m !== 'string');
    // Vacuity: the processor, the memory extractor and the briefing worker at least.
    expect(resolved.length).toBeGreaterThanOrEqual(3);
    const short = resolved
      .filter((m) => m.visibility < 6 * m.timeout + m.window)
      .map((m) => `${m.where}: visibility ${m.visibility} s < 6 x ${m.timeout} s + ${m.window} s`);
    expect(short).toStrictEqual([]);
  });

  it('holds the feedback processor queue to it (the one that was 360 s against a 300 s function)', () => {
    const processor = sqsMappings(stacksOf(SHAPES.default))
      .find((m) => typeof m !== 'string' && m.where.includes('FeedbackProcessorSqsEventSource'));
    expect(processor).toMatchObject({ timeout: 300, window: 5, visibility: 1805 });
  });
});

// ── 3. The all-features synth is clean ───────────────────────────────

describe('the all-features synth', () => {
  it('reads real annotations and reports no cdk-nag error or CDK warning', () => {
    expect(SHAPES.allFeatures.readsRealAnnotations).toBe(true);
    expect(diagnostics(SHAPES.allFeatures).map((d) => `${d.path}: ${d.data.slice(0, 160)}`)).toStrictEqual([]);
  });
});

// The e2e profile (Haiku 5.5 + its capacity fallback, docs: e2e/README.md "Models") applies to every
// Bedrock caller, so every Claude grant must name both models (the eu. twin: app-inference-scope.test.ts).
describe('Bedrock grants for the e2e profile models', () => {
  it.each(Object.entries(SHAPES))('every Claude InvokeModel statement names their global. profile and foundation model (%s)', (_shape, result) => {
    const statements = claudeInvokeStatements(result);
    expect(statements.length).toBeGreaterThan(5);
    expect(missingModelGrants(statements, e2eProfileModels(), 'global')).toStrictEqual([]);
    // Not vacuous: an id that is only a prefix of a granted one (claude-haiku-5 of claude-haiku-5-5) is missing.
    expect(missingModelGrants(statements, ['global.anthropic.claude-haiku-5'], 'global')).toHaveLength(2 * statements.length);
  });
});
