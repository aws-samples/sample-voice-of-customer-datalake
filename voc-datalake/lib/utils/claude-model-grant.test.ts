/**
 * The Claude grant's IAM shape (lib/utils/claude-model-grant.ts), pinned on one role of a minimal stack in both
 * inference scopes: the three parts AWS documents for global cross-Region inference, the `eu.` shape with each
 * destination Region, the conditions, the sharing across roles and the managed-policy size.
 * The whole-app check that EVERY Claude-invoking role holds every part: lib/app-template-gates.test.ts and
 * lib/app-inference-scope.test.ts.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  assertFitsManagedPolicy, CLAUDE_INVOKE_ACTIONS, type ClaudeInvokeVariant, grantClaudeModels, MODELS_PER_POLICY,
} from './claude-model-grant';
import { parseCustomModels, type RegistryTarget } from './custom-models';
import { ALLOWED_MODEL_IDS, toFoundationModelId } from './model-allowlist';

const ACCOUNT = '111111111111';
const MANAGED_POLICY_LIMIT = 6_144;
const WARN_FRACTION = 0.7;

type RoleSpec = readonly [id: string, variant: ClaudeInvokeVariant];

/** A stack whose roles each hold one inline statement (so a default policy exists) and then the Claude grant. */
function stackWithRoles(region: string, context: Record<string, unknown> = {}, roles: readonly RoleSpec[] = [['RoleA', 'invoke']]): Template {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, 'Grant', { env: { account: ACCOUNT, region } });
  for (const [id, variant] of roles) {
    const role = new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: ['arn:aws:sqs:us-east-1:111111111111:q'] }));
    grantClaudeModels(role, variant);
  }
  return Template.fromStack(stack);
}

const ManagedPolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.object({ Ref: z.string() })),
    PolicyDocument: z.object({ Statement: z.array(z.unknown()) }),
  }),
});

function managedPolicies(template: Template): [string, z.infer<typeof ManagedPolicySchema>][] {
  return Object.entries(template.findResources('AWS::IAM::ManagedPolicy'))
    .map(([id, resource]) => [id, ManagedPolicySchema.parse(resource)]);
}

/** The statements of the stack's first `invoke` Claude policy. */
const firstPolicyStatements = (template: Template) =>
  managedPolicies(template).find(([id]) => id.startsWith('ClaudeInvokePolicy0'))?.[1].Properties.PolicyDocument.Statement;

/**
 * Parts 1 and 2 as synthesized: the profiles, then `regional` through those profiles only; with `requesting`
 * (global scope) both also carry `aws:RequestedRegion` = that region, as the global doc's example does.
 */
const profileAndRegionalParts = (profiles: string[], regional: string[], requesting?: string) => {
  const inRegion = requesting === undefined ? {} : { 'aws:RequestedRegion': requesting };
  return [
    {
      Sid: 'ClaudeProfiles', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: profiles,
      ...(requesting === undefined ? {} : { Condition: { StringEquals: inRegion } }),
    },
    {
      Sid: 'ClaudeRegionalModels', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: regional,
      Condition: { StringEquals: { ...inRegion, 'bedrock:InferenceProfileArn': profiles } },
    },
  ];
};

const models = ALLOWED_MODEL_IDS.slice(0, MODELS_PER_POLICY);
const profileArn = (region: string, prefix: string, id: string) =>
  `arn:aws:bedrock:${region}:${ACCOUNT}:inference-profile/${prefix}${toFoundationModelId(id)}`;

describe('grantClaudeModels, global scope (default)', () => {
  const template = stackWithRoles('us-east-1');
  const profiles = models.map((id) => profileArn('us-east-1', 'global.', id));

  it('grants the first policy\'s models in exactly the three documented parts', () => {
    expect(firstPolicyStatements(template)).toStrictEqual([
      ...profileAndRegionalParts(profiles, models.map((id) => `arn:aws:bedrock:us-east-1::foundation-model/${toFoundationModelId(id)}`), 'us-east-1'),
      {
        Sid: 'ClaudeGlobalModels', Effect: 'Allow', Action: 'bedrock:InvokeModel',
        Resource: models.map((id) => `arn:aws:bedrock:::foundation-model/${toFoundationModelId(id)}`),
        Condition: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': profiles } },
      },
    ]);
  });

  it('covers every allowlisted model across the policies, attached to the role', () => {
    const policies = managedPolicies(template);
    expect(policies).toHaveLength(Math.ceil(ALLOWED_MODEL_IDS.length / MODELS_PER_POLICY));
    const text = JSON.stringify(policies);
    for (const id of ALLOWED_MODEL_IDS) expect(text).toContain(`"${profileArn('us-east-1', 'global.', id)}"`);
    expect(text).not.toContain('*');
    for (const [, policy] of policies) expect(policy.Properties.Roles.map((r) => r.Ref.replace(/[0-9A-F]{8}$/, ''))).toStrictEqual(['RoleA']);
  });

  it('makes the role\'s inline policy wait for the managed ones (no AccessDenied gap on the upgrade deploy)', () => {
    const [inline] = Object.values(template.findResources('AWS::IAM::Policy'));
    const dependsOn = z.object({ DependsOn: z.array(z.string()) }).parse(inline).DependsOn;
    expect(dependsOn.filter((id) => id.startsWith('ClaudeInvokePolicy'))).toHaveLength(managedPolicies(template).length);
  });

  it('also orders a default policy created AFTER the Claude grant (the processing role\'s order)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Late', { env: { account: ACCOUNT, region: 'us-east-1' } });
    const role = new iam.Role(stack, 'Late', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    grantClaudeModels(role, 'stream');
    role.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: ['arn:aws:sqs:us-east-1:111111111111:q'] }));
    const late = Template.fromStack(stack);
    const [inline] = Object.values(late.findResources('AWS::IAM::Policy'));
    const dependsOn = z.object({ DependsOn: z.array(z.string()) }).parse(inline).DependsOn;
    expect(dependsOn.filter((id) => id.startsWith('ClaudeInvokeStreamPolicy'))).toHaveLength(managedPolicies(late).length);
  });
});

describe('grantClaudeModels sharing', () => {
  const template = stackWithRoles('us-east-1', {}, [['RoleA', 'invoke'], ['RoleC', 'invoke'], ['RoleB', 'stream']]);

  it('shares one policy set per action variant across the stack\'s roles', () => {
    const byVariant = (prefix: string) => managedPolicies(template).filter(([id]) => id.startsWith(prefix));
    const perVariant = Math.ceil(ALLOWED_MODEL_IDS.length / MODELS_PER_POLICY);
    const invoke = byVariant('ClaudeInvokePolicy');
    const stream = byVariant('ClaudeInvokeStreamPolicy');
    expect([invoke.length, stream.length]).toStrictEqual([perVariant, perVariant]);
    for (const [, policy] of invoke) expect(policy.Properties.Roles).toHaveLength(2);
    for (const [, policy] of stream) {
      expect(policy.Properties.Roles).toHaveLength(1);
      expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain(JSON.stringify(CLAUDE_INVOKE_ACTIONS.stream));
    }
  });
});

describe('grantClaudeModels, -c inferenceScope=eu', () => {
  const template = stackWithRoles('eu-central-1', { inferenceScope: 'eu' });
  const profiles = models.map((id) => profileArn('eu-central-1', 'eu.', id));
  const destinations = ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'];

  it('grants the eu. profiles and each model in every destination Region, through those profiles only', () => {
    expect(firstPolicyStatements(template)).toStrictEqual(profileAndRegionalParts(
      profiles,
      models.flatMap((id) => destinations.map((r) => `arn:aws:bedrock:${r}::foundation-model/${toFoundationModelId(id)}`)),
    ));
  });

  it('grants no global. profile and no Region-agnostic model', () => {
    const text = JSON.stringify(managedPolicies(template));
    expect(text).not.toContain('global.');
    expect(text).not.toContain('bedrock:::');
  });
});

describe('managed-policy size', () => {
  // The largest shapes: global, and eu from a source Region that adds itself to the destinations.
  it.each([['us-east-1', {}], ['eu-west-2', { inferenceScope: 'eu' }], ['eu-central-2', { inferenceScope: 'eu' }]])(
    'keeps every Claude policy under 70%% of the 6,144-char managed quota (%s)',
    (region, context) => {
      const sizes = managedPolicies(stackWithRoles(region, context, [['RoleA', 'invoke'], ['RoleB', 'stream']]))
        .map(([id, policy]) => ({ id, chars: JSON.stringify(policy.Properties.PolicyDocument).length }));
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.filter((s) => s.chars >= MANAGED_POLICY_LIMIT * WARN_FRACTION)).toStrictEqual([]);
    },
  );
});

describe('grantClaudeModels with -c customModels (7.65.00)', () => {
  const CAPABILITIES = { tools: true, documents: true, json: true, temperature: true };
  const custom = (key: string, id: string, extra: Record<string, unknown> = {}) => ({
    key, id, label: key, kind: 'bedrock', surfaces: ['documents'], eu: false, capabilities: CAPABILITIES, price: { in: 1, out: 2 }, ...extra,
  });
  const registry = [
    custom('nova', 'amazon.nova-pro-v1:0'),
    custom('lite', 'global.amazon.nova-2-lite-v1:0'),
    custom('llama', 'us.meta.llama3-3-70b-instruct-v1:0', { regions: ['us-east-1', 'us-east-2', 'us-west-2'] }),
    custom('mine', `arn:aws:bedrock:us-west-2:${ACCOUNT}:imported-model/abc123def456`, { kind: 'imported' }),
  ];
  const template = stackWithRoles('us-west-2', { customModels: JSON.stringify(registry) }, [['RoleA', 'invoke'], ['RoleB', 'stream']]);
  const text = JSON.stringify(managedPolicies(template));

  it('adds each custom model to the shared policies by its exact ARNs, spread over the parts', () => {
    const invoke = managedPolicies(template).filter(([id]) => id.startsWith('ClaudeInvokePolicy'));
    expect(invoke).toHaveLength(Math.ceil(ALLOWED_MODEL_IDS.length / MODELS_PER_POLICY));
    const sids = invoke.map(([, policy]) => policy.Properties.PolicyDocument.Statement
      .flatMap((statement) => z.object({ Sid: z.string() }).parse(statement).Sid).filter((sid) => sid.startsWith('Custom')));
    expect(sids).toStrictEqual([
      ['CustomModels', 'CustomGeoProfiles', 'CustomGeoRegionalModels'],
      ['CustomModels', 'CustomCrossRegionProfiles', 'CustomCrossRegionRegionalModels', 'CustomCrossRegionGlobalModels'],
    ]);
    for (const arn of [
      'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0',
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:imported-model/abc123def456`,
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/global.amazon.nova-2-lite-v1:0`,
      'arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0',
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/us.meta.llama3-3-70b-instruct-v1:0`,
      'arn:aws:bedrock:us-east-2::foundation-model/meta.llama3-3-70b-instruct-v1:0',
    ]) expect(text).toContain(`"${arn}"`);
  });

  it('grants no wildcard, no provisioned throughput and no model-management action', () => {
    expect(text).not.toContain('*');
    expect(text).not.toContain('foundation-model/*');
    expect(text).not.toMatch(/bedrock:(?:Create|Delete|Update)|ProvisionedModelThroughput|provisioned-model/);
  });

  it('keeps the stream variant\'s actions on the custom models too', () => {
    const stream = managedPolicies(template).filter(([id]) => id.startsWith('ClaudeInvokeStreamPolicy'));
    expect(JSON.stringify(stream)).toContain('"CustomModels"');
    expect(JSON.stringify(stream)).toContain(JSON.stringify(CLAUDE_INVOKE_ACTIONS.stream));
  });

  it('leaves every template without the key unchanged (the default synth is pinned by app-baseline.test.ts)', () => {
    expect(JSON.stringify(managedPolicies(stackWithRoles('us-west-2')))).not.toContain('Custom');
  });

  // The largest shapes the registry allows (four models, and an env value of at most 1,200 characters): eu. profiles
  // from eu-central-2 (seven destinations each), and us. profiles with eight declared Regions, both with ids of 48
  // characters, the longest listed in us-west-2 and eu-central-1 on 2026-11-21. As many as fit.
  const long = (prefix: string, i: number) => `${prefix}.example.${'model-name-'.repeat(3)}${i}-v1:0`.padEnd(48, 'x');
  const fitting = (models: Record<string, unknown>[], target: RegistryTarget) => {
    const fits = (n: number) => {
      try {
        return parseCustomModels(models.slice(0, n), target).length === n;
      } catch {
        return false;
      }
    };
    return models.slice(0, [4, 3, 2, 1].find(fits) ?? 0);
  };
  it.each([
    ['eu-central-2', { inferenceScope: 'eu' }, fitting([0, 1, 2, 3].map((i) => custom(`e${i}`, long('eu', i), { eu: true })),
      { region: 'eu-central-2', account: ACCOUNT, scope: 'eu' })],
    ['us-east-1', {}, fitting([0, 1, 2, 3].map((i) => custom(`u${i}`, long('us', i), {
      regions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'ca-west-1', 'mx-central-1', 'us-west-3'],
    })), { region: 'us-east-1', account: ACCOUNT, scope: 'global' })],
  ])('keeps every shared policy under 90%% of the 6,144-character managed quota with the largest registry (%s)', (region, context, models) => {
    expect(models.length).toBeGreaterThanOrEqual(2);
    const sizes = managedPolicies(stackWithRoles(region, { ...context, customModels: models }, [['RoleA', 'invoke'], ['RoleB', 'stream']]))
      .map(([id, policy]) => ({ id, chars: JSON.stringify(policy.Properties.PolicyDocument).length }));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((s) => s.chars >= MANAGED_POLICY_LIMIT * 0.9)).toStrictEqual([]);
  });

  it('refuses at synth a grant that would pass the quota', () => {
    const stack = new cdk.Stack(new cdk.App(), 'Big', { env: { account: ACCOUNT, region: 'us-east-1' } });
    const arns = Array.from({ length: 120 }, (_, i) => `arn:aws:bedrock:us-east-1::foundation-model/example.model-${String(i)}-v1:0`);
    const statement = new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: arns });
    expect(() => assertFitsManagedPolicy(stack, 'P', [statement])).toThrow(/over the 6144-character managed-policy quota/);
    expect(() => assertFitsManagedPolicy(stack, 'P', [new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: arns.slice(0, 5) })]))
      .not.toThrow();
  });
});
